"""eBay API client: OAuth, purchases (Trading API) and sales (Sell Fulfillment API)."""

import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import requests

SCOPES = " ".join(
    [
        "https://api.ebay.com/oauth/api_scope",
        "https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly",
    ]
)
TRADING_NS = {"e": "urn:ebay:apis:eBLBaseComponents"}
TRADING_VERSION = "1193"
TIMEOUT = 30


class EbayError(Exception):
    pass


def _hosts(cfg):
    if cfg.get("ebay_env") == "sandbox":
        return "https://auth.sandbox.ebay.com", "https://api.sandbox.ebay.com"
    return "https://auth.ebay.com", "https://api.ebay.com"


def is_configured(cfg):
    return all(cfg.get(k) for k in ("ebay_client_id", "ebay_client_secret", "ebay_runame"))


def consent_url(cfg):
    auth_host, _ = _hosts(cfg)
    query = urlencode(
        {
            "client_id": cfg["ebay_client_id"],
            "redirect_uri": cfg["ebay_runame"],
            "response_type": "code",
            "scope": SCOPES,
        }
    )
    return f"{auth_host}/oauth2/authorize?{query}"


def _token_request(cfg, data):
    _, api_host = _hosts(cfg)
    try:
        resp = requests.post(
            f"{api_host}/identity/v1/oauth2/token",
            auth=(cfg["ebay_client_id"], cfg["ebay_client_secret"]),
            data=data,
            timeout=TIMEOUT,
        )
    except requests.RequestException as exc:
        raise EbayError(f"Could not reach eBay: {exc}") from exc
    try:
        body = resp.json()
    except ValueError:
        body = {}
    if resp.status_code != 200:
        detail = body.get("error_description") or body.get("error") or resp.text[:200]
        raise EbayError(f"eBay sign-in failed: {detail}")
    body["expires_at"] = int(time.time()) + int(body.get("expires_in", 0))
    return body


def exchange_code(cfg, code):
    return _token_request(
        cfg,
        {"grant_type": "authorization_code", "code": code, "redirect_uri": cfg["ebay_runame"]},
    )


def refresh_access_token(cfg, refresh_token):
    return _token_request(
        cfg, {"grant_type": "refresh_token", "refresh_token": refresh_token, "scope": SCOPES}
    )


def _iso(moment):
    return moment.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _text(node, path):
    found = node.find(path, TRADING_NS)
    return found.text.strip() if found is not None and found.text else ""


def parse_purchases(xml_text):
    """Parse a Trading API GetOrders response into (purchases, has_more)."""
    root = ET.fromstring(xml_text)
    if _text(root, "e:Ack") not in ("Success", "Warning"):
        message = _text(root, "e:Errors/e:LongMessage") or _text(root, "e:Errors/e:ShortMessage")
        raise EbayError(f"eBay returned an error: {message or 'unknown error'}")

    purchases = []
    for order in root.findall("e:OrderArray/e:Order", TRADING_NS):
        if _text(order, "e:OrderStatus") in ("Cancelled", "Inactive"):
            continue
        order_id = _text(order, "e:OrderID")
        seller = _text(order, "e:SellerUserID")
        created = _text(order, "e:CreatedTime")
        for txn in order.findall("e:TransactionArray/e:Transaction", TRADING_NS):
            price_node = txn.find("e:TransactionPrice", TRADING_NS)
            try:
                price = float(price_node.text)
            except (AttributeError, TypeError, ValueError):
                price = None
            try:
                quantity = int(_text(txn, "e:QuantityPurchased") or 1)
            except ValueError:
                quantity = 1
            purchases.append(
                {
                    "order_id": order_id,
                    "ebay_item_id": _text(txn, "e:Item/e:ItemID"),
                    "transaction_id": _text(txn, "e:TransactionID"),
                    "title": _text(txn, "e:Item/e:Title"),
                    "price": price,  # per unit
                    "currency": price_node.get("currencyID", "") if price_node is not None else "",
                    "quantity": quantity,
                    "seller": seller,
                    "purchased_at": _text(txn, "e:CreatedTime") or created,
                }
            )
    return purchases, _text(root, "e:HasMoreOrders") == "true"


def fetch_purchases(cfg, token, days=90):
    """Everything bought on the connected account in the last `days` days (eBay allows up to 90)."""
    _, api_host = _hosts(cfg)
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=min(int(days), 90))
    headers = {
        "X-EBAY-API-SITEID": str(cfg.get("ebay_site_id") or "3"),
        "X-EBAY-API-COMPATIBILITY-LEVEL": TRADING_VERSION,
        "X-EBAY-API-CALL-NAME": "GetOrders",
        "X-EBAY-API-IAF-TOKEN": token,
        "Content-Type": "text/xml",
    }
    purchases = []
    page = 1
    while True:
        body = (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">'
            f"<CreateTimeFrom>{_iso(start)}</CreateTimeFrom>"
            f"<CreateTimeTo>{_iso(now)}</CreateTimeTo>"
            "<OrderRole>Buyer</OrderRole>"
            "<OrderStatus>All</OrderStatus>"
            f"<Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>{page}</PageNumber></Pagination>"
            "</GetOrdersRequest>"
        )
        try:
            resp = requests.post(
                f"{api_host}/ws/api.dll", headers=headers, data=body.encode("utf-8"), timeout=TIMEOUT
            )
        except requests.RequestException as exc:
            raise EbayError(f"Could not reach eBay: {exc}") from exc
        if resp.status_code != 200:
            raise EbayError(f"eBay returned HTTP {resp.status_code}: {resp.text[:200]}")
        batch, has_more = parse_purchases(resp.content)
        purchases.extend(batch)
        if not has_more or page >= 50:
            return purchases
        page += 1


def _amount(node):
    try:
        return float((node or {}).get("value"))
    except (TypeError, ValueError):
        return 0.0


def parse_sales(payload):
    """Parse a Sell Fulfillment getOrders response into a list of sold order lines."""
    sales = []
    for order in payload.get("orders", []):
        if (order.get("cancelStatus") or {}).get("cancelState") == "CANCELED":
            continue
        lines = order.get("lineItems", [])
        order_fee = _amount(order.get("totalMarketplaceFee"))
        order_cost = sum(_amount(line.get("lineItemCost")) for line in lines)
        for line in lines:
            cost = _amount(line.get("lineItemCost"))
            # eBay reports fees per order, so share them across lines by value
            share = cost / order_cost if order_cost else 1 / len(lines)
            sales.append(
                {
                    "order_id": order.get("orderId", ""),
                    "line_item_id": line.get("lineItemId", ""),
                    "ebay_item_id": line.get("legacyItemId", ""),
                    "title": line.get("title", ""),
                    "price": cost,
                    "fee": round(order_fee * share, 2),
                    "currency": (line.get("lineItemCost") or {}).get("currency", ""),
                    "quantity": int(line.get("quantity") or 1),
                    "buyer": (order.get("buyer") or {}).get("username", ""),
                    "sold_at": order.get("creationDate", ""),
                }
            )
    return sales


def fetch_sales(cfg, token, days=90):
    """Everything sold on the connected account in the last `days` days."""
    _, api_host = _hosts(cfg)
    start = datetime.now(timezone.utc) - timedelta(days=int(days))
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    sales = []
    offset = 0
    limit = 200
    while True:
        try:
            resp = requests.get(
                f"{api_host}/sell/fulfillment/v1/order",
                headers=headers,
                params={"filter": f"creationdate:[{_iso(start)}..]", "limit": limit, "offset": offset},
                timeout=TIMEOUT,
            )
        except requests.RequestException as exc:
            raise EbayError(f"Could not reach eBay: {exc}") from exc
        try:
            payload = resp.json()
        except ValueError:
            payload = {}
        if resp.status_code != 200:
            errors = payload.get("errors") or [{}]
            detail = errors[0].get("longMessage") or errors[0].get("message") or resp.text[:200]
            raise EbayError(f"eBay returned an error: {detail}")
        sales.extend(parse_sales(payload))
        offset += limit
        if offset >= int(payload.get("total") or 0) or offset >= 10000:
            return sales
