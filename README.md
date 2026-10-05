# Recycling Inventory

Barcode inventory for a repair and electronics recycling business. It runs in Docker and keeps everything in one file
(`data/inventory.db`). The look and the scanner behaviour follow Inventory Control 2.

- **Repairs** — things you buy to fix and sell (motherboards and the like), with the price paid, model, serial number,
  MAC address, fault and repair notes.
- **eBay purchases** — pull in what you bought on eBay and turn each purchase into an inventory item.
- **Labels** — every item gets a number (`R00001`, `R00002`…) and a printable barcode label. Scanning it opens the item.
- **WEEE collections** — log each pick-up and what came in with it. Anything that holds data has to be recorded as
  wiped or destroyed before it can be sold or recycled, and every wipe goes in a log you can export.
- **Sales** — mark an item as sold by hand, or match it to an eBay sale so the price and fees fill themselves in.
  Profit is worked out per item.

## Running it

On the server, from inside this folder:

    docker compose up -d --build

The site is then at `http://<server-address>:8080`. To use a different port, change the `8080` in `docker-compose.yml`.

The database is kept in the `data` folder next to `docker-compose.yml`, so it survives restarts and rebuilds.

- Update after changing the code: `docker compose up -d --build`
- Logs: `docker compose logs -f`

### Password

The site has no user accounts. To make the browser ask for a login, uncomment `AUTH_USER` and `AUTH_PASS` in
`docker-compose.yml` and start it again. The password travels unencrypted unless the server puts https in front of
the site, so keep it on your own network or behind an https reverse proxy. Do not expose it straight to the internet.

## Using the barcode scanner

A USB or Bluetooth scanner works like a keyboard, so there is nothing to set up. On any page, scan and the item opens.
It looks for, in order: the label's barcode, an item's serial number, a MAC address, then a drive's serial number.

- On the **Add item** page, a scan goes into the serial number box (or the MAC address box if it is a MAC address).
- You can also click into any box and scan straight into it — a drive's serial number, for example.
- A code that is not in the system offers to add a new item with that serial number.

## Labels

Open an item and press **Print label**, or tick several in the inventory and press **Print labels**. A collection has
**Print all labels**. The labels open as a PDF, one label per page.

Set your label size in millimetres under **Settings** (62 × 29 mm to start with). In the print dialog choose the label
printer, no margins, 100% scale.

The label shows the name, model, serial number, MAC address and the barcode. The price paid is on the item's page when
you scan it; it is not printed, because the label stays on the item when you sell it.

## Repairs: buying, fixing, selling

1. **eBay purchases → Fetch from eBay** pulls in the last 90 days. For each one, **Add to inventory** creates the item
   straight away, or **Add with details** opens the form first. The price paid is the item price plus postage.
   Things that are not stock (tools, packaging) can be hidden.
2. Print the label. When the board arrives, scan it, press **Edit** and scan in its serial number and MAC address.
3. Move it through **In stock → In repair → Ready to sell → Listed for sale** with the Status list, and keep repair
   notes on its page. Parts you buy for it go in **Repair cost**.
4. When it sells on eBay: **Sold on eBay → Fetch from eBay**, then **Match to an item**. The site suggests the items
   whose name and model look like the listing; you can also search, or scan the label of the item you are packing.
   The sale price and eBay fees are filled in, and you add what the postage cost you.
5. Sold somewhere else? Open the item and press **Mark as sold**.

**Sales & profit** lists everything sold: price, fees, postage, cost and profit.

## WEEE collections and data wiping

1. **WEEE collections → New collection**: who it came from and when.
2. On the collection's page, add what you picked up. "How many" adds several identical items at once, each with its own
   label. Leave **Holds data** ticked for anything with a drive or built-in storage.
3. **Data wiping** lists everything still holding data. Either press **Mark wiped** there, or open the item to record
   each drive's serial number and wipe them one by one. Choose how it was cleared (overwrite, secure erase, factory
   reset, degaussed, physically destroyed).
4. Until that is done, the item cannot be marked sold or recycled.

**Export wipe log (CSV)** on the Data wiping page gives you the full record: what was cleared, how, when, and which
collection it came from.

## Connecting eBay

You need a free eBay developer account. This is a one-off job.

1. Sign up at <https://developer.ebay.com> and wait for the account to be approved.
2. Under **Application Keys**, create a **Production** keyset. eBay asks you to either subscribe to or opt out of
   "marketplace account deletion" notifications first — for a tool that only reads your own account you can apply for
   the exemption.
3. Next to the production App ID click **User Tokens → Get a Token from eBay via Your Application**, and add an eBay
   redirect URL (RuName). The "auth accepted URL" must be an https address; any page you like will do, such as your
   own website.
4. In this site go to **Settings** and enter the **App ID**, **Cert ID** and **RuName**, then **Save keys**.
5. Press **Sign in to eBay** and agree. eBay sends you to your "auth accepted URL" — copy the whole address of that
   page from the browser's address bar, paste it into the box on the Settings page and press **Finish connecting**.
   The address only works for a few minutes.

If this site is reachable over https, you can set the "auth accepted URL" to `https://<your-site>/ebay/callback`
instead and step 5 finishes by itself.

The site only ever reads from eBay: your purchases (Trading API `GetOrders`) and your sales (Sell Fulfillment API).
It cannot list, buy or change anything. eBay hands out the last 90 days, so fetch at least that often.

## Backups

**Backup** in the sidebar downloads a copy of the database. It is the whole system — stock, wipe log, sales and your
eBay keys — so keep copies somewhere safe and treat them as private.

## Running it without Docker

Needs Node.js 22.13 or newer.

    npm install
    npm start

The site is then at <http://localhost:3000>.
