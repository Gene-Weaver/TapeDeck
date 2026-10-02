# TapeDeck

A local label studio for the **Brother PT-P700**. Design single labels, sequential
patterns, or whole batches from a list, see every label to scale on a virtual tape,
then watch an animated PT-P700 print and cut them while the real one does the same.

No Brother driver, no P-touch Editor, no cloud. TapeDeck speaks the printer's raster
protocol directly over USB (`pyusb` + `libusb`) and renders every label in the browser,
so what you see on the tape preview is exactly the bitmap the printer receives.

```
browser (canvas, 180 dpi, 1-bit)  →  PNG  →  FastAPI  →  raster commands  →  libusb  →  PT-P700
```

## Run it

```bash
brew install libusb            # macOS; on Ubuntu: sudo apt install libusb-1.0-0
./run.sh                       # creates .venv on first run, opens http://127.0.0.1:8765
./run.sh --mock                # no printer: simulates one and saves labels to out/
```

Options: `--port 8765`, `--mock-tape 12` (width the mock reports), `--fast-mock`
(mock prints instantly), `--no-browser`.

Mock mode can also be toggled at runtime from the ⚙ settings dialog.

## First print checklist

1. Plug the PT-P700 in over USB and turn it on.
2. **Turn P-Lite off.** If the green P-Lite light is on, hold the P-Lite button for
   about two seconds. In P-Lite mode the printer shows up as a USB drive and will not
   accept raster commands. In normal mode it is USB `04f9:2061`.
3. macOS: quit P-touch Editor and any Brother driver utilities so nothing else holds
   the USB interface. If `libusb` reports "access denied", run `./run.sh` with `sudo`
   once to confirm, then fix permissions. Linux: add a udev rule for `04f9:2061` or
   run with `sudo`.
4. The status pill at the top right should say `PT-P700 · 12 mm laminated tape` (or
   whatever cassette is loaded). Set the **Tape** selector to match. Printing refuses to
   start when the loaded cassette differs from the job, unless you disable the check in
   settings.
5. Print one short label. If it comes out **upside down**, open ⚙ settings and tick
   **Flip pin order**. If it comes out **mirrored**, the mirror option is on. If the
   text sits too close to one edge, nudge it in the Designer.

## Tabs

| Tab | What it does |
|-----|--------------|
| **Single Text** | One label (or N copies). Font, bold/italic/invert, auto-fit height, border, auto or fixed length, padding live in the Style panel. |
| **Pattern** | *Prefix + counter + suffix* (`LEAF-0001` …) or a *template* with tokens: `{n}`, `{n:06}`, `{i}`, `{A}`/`{a}` letters, `{date}`, `{time}`. |
| **Batch** | Paste lines or a CSV/TSV (or load a file). With a header row, columns become tokens: `{name} #{id}`. |
| **Designer** | Drag-and-drop layout: text, photos (Floyd–Steinberg dithered), QR codes, Code 128 barcodes, boxes, lines. Rotation, centering, mm positioning. Save/load/export/import templates. |

The **Tape preview** dock at the bottom always shows every label that will print, to
scale, with margins and cut lines, plus the total tape length and an estimated print
time. Tick **Use Designer layout** to run Pattern or Batch values through your layout:
any `{text}` or `{n}` token in a Designer element is replaced per label.

**Print** renders every label, sends the job, and opens the print theater: the PT-P700
feeds each label out of its slot, the cutter snaps, and the label drops onto the pile,
in step with the real job's progress. **Export PNGs** saves the same bitmaps into
`out/export_<timestamp>/` without printing.

## Tape geometry

Dots at 180 dpi (7.09 dots/mm). The head has 128 pins; narrow tapes use the centre.

| Tape | Printable dots | Printable height |
|------|---------------:|-----------------:|
| 3.5 mm | 24 | 3.4 mm |
| 6 mm | 32 | 4.5 mm |
| 9 mm | 50 | 7.1 mm |
| 12 mm | 70 | 9.9 mm |
| 18 mm | 112 | 15.8 mm |
| 24 mm | 128 | 18.1 mm |

Source: Brother *Raster Command Reference, PT-H500/P700/E500*. (Some online snippets
quote 52/76/120 dots for 9/12/18 mm; those are wrong for this head.)

## Repo layout

```
tapedeck/
  __main__.py         CLI: python -m tapedeck [--mock] [--port]
  server.py           FastAPI: /api/status /api/print /api/export /api/jobs/{id} /api/mock
  jobs.py             background job runner with pollable progress
  imaging.py          PNG -> 1-bit pin columns
  ptouch/
    tapes.py          tape table (pins, margins)
    protocol.py       raster command builders, PackBits, job assembly
    status.py         32-byte status block parser
    transport.py      UsbTransport (pyusb) and MockTransport
    printer.py        Printer: status check, media validation, page-by-page printing
ui/
  index.html, css/app.css
  js/app.js           state, tabs, tape preview strip, print flow
  js/render.js        layout -> 1-bit canvas (text, image dithering, QR, barcode)
  js/designer.js      drag-and-drop editor + properties panel
  js/printer-anim.js  the print theater
  js/pattern.js       counter / template / CSV expansion
  js/codes.js         Code 128 encoder, QR wrapper (vendor/qrcode.js, MIT)
tests/
  test_protocol.py    pytest: packbits, raster geometry, job bytes, mock end-to-end
  test_js_logic.mjs   node: pattern expansion, CSV, Code 128
```

## Tests

```bash
.venv/bin/python -m pytest -q
node tests/test_js_logic.mjs
```

## Protocol notes

Per job: 100×`00` invalidate, `ESC @`, `ESC i a 01` (raster mode). Per page:
`ESC i z` print information (media width + raster line count), `ESC i M` (auto-cut,
mirror), `ESC i K` (chain printing off only on the last page so the tape is fed and cut
at the end), `ESC i A` cut-every-N, `ESC i d` margin (min 14 dots), `M 02` PackBits,
then one `G`/`Z` raster line per column and `FF` (more pages follow) or `^Z` (last page).
Each raster line is 16 bytes; pin 0 is bit 7 of byte 0 and sits at the tape's bottom
edge, which is why columns are reversed before packing (`columns_to_raster_lines`).
