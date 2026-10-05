# Recycling Inventory

Inventory tracking for a repair and electronics recycling business. Runs in Docker and
keeps everything in a single file (`data/inventory.db`).

- Stock and recycling items, each with a price paid, serial numbers, MAC addresses and other IDs
- Pull your eBay purchases in and turn them into inventory items
- Pull your eBay sales in and link each one to the item that was sold, with fees and profit
- Record which items have had their storage wiped, and see what is still waiting
- Print barcode labels; scan a label (or a serial number) to bring the item up

## Running it

On the server, from inside this folder:

    docker compose up -d --build

The site is then at `http://<server-address>:5000`. The database is kept in the `data` folder
next to `docker-compose.yml`, so it survives restarts and rebuilds — back that folder up.

The site has no user accounts. To require a password, create a file called `.env` next to
`docker-compose.yml` before starting it:

    APP_PASSWORD=choose-something-long
    PORT=5000

The browser will then ask for a username and password; any username works. The password is sent
unencrypted unless the server puts https in front of the site, so keep it on your own network
or behind a reverse proxy with https.

To update after changing the code: `docker compose up -d --build`. To see logs:
`docker compose logs -f`.

## Using the barcode scanner

The scanner works like a keyboard, so there is nothing to set up. On any page, scan a label and
the item opens. Scanning a serial number or MAC address that is recorded against an item works too.

When adding an item, click into an ID box and scan the serial number; the cursor moves to a new
row ready for the next one.

## Labels

Open an item and press **Print label**, or tick several items in the inventory list and press
**Print labels for ticked items**. Set your label size (in mm) under **Settings** — the default is
62 × 29 mm. In the print dialog choose your label printer, margins "None", scale 100%.

## Connecting eBay

You need a free eBay developer account. This is a one-off job.

1. Sign up at <https://developer.ebay.com> and wait for the account to be approved.
2. Under **Application Keys**, create a **Production** keyset. eBay will ask you to either
   subscribe to or opt out of "marketplace account deletion" notifications first — for a tool
   that only reads your own account you can apply for the exemption.
3. Next to the production App ID click **User Tokens → Get a Token from eBay via Your
   Application**, and add an eBay redirect URL (RuName). Fill in the form; the "auth accepted
   URL" can be any https address you like, such as your own website.
4. In this app go to **Settings** and enter the **App ID**, **Cert ID** and **RuName**, then save.
5. Press **Sign in to eBay** and agree. eBay then sends you to your "auth accepted URL" — copy the
   whole address of that page from the browser's address bar, paste it into the box on the
   Settings page and press **Finish connecting**. The address is only valid for a few minutes.

After that, **eBay purchases → Fetch from eBay** and **eBay sold → Fetch from eBay** pull your
orders in. eBay only provides purchases from the last 90 days, so fetch at least that often.

## Backups

Copy `data/inventory.db` somewhere safe regularly — it is the whole system. It also contains your
eBay keys, so treat it as private.

## Notes

The site is reachable by anything that can reach the server's port, so set `APP_PASSWORD` and do
not expose it straight to the internet.
