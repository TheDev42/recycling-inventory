# Recycling Inventory

Inventory tracking for a repair and electronics recycling business. Runs on your own PC and
keeps everything in a single file (`inventory.db`).

- Stock and recycling items, each with a price paid, serial numbers, MAC addresses and other IDs
- Pull your eBay purchases in and turn them into inventory items
- Pull your eBay sales in and link each one to the item that was sold, with fees and profit
- Record which items have had their storage wiped, and see what is still waiting
- Print barcode labels; scan a label (or a serial number) to bring the item up

## Starting it

Double-click `run.bat`. The first run installs what it needs, then the site opens at
<http://127.0.0.1:5000>. Leave the black window open while you use it.

Needs Python 3.10 or newer.

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

Copy `inventory.db` somewhere safe regularly — it is the whole system. It also contains your
eBay keys, so treat it as private.

## Notes

The site only listens on this PC. It has no login, so do not expose it to the internet.
