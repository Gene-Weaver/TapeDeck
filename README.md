# TapeDeck

A desktop label studio for the **Brother PT-P700** (macOS, Windows, Linux). Design single
labels, sequential patterns, or whole batches from a list, see every label to scale on a
virtual tape, then watch an animated PT-P700 print and cut them while the real one does
the same.

No Brother driver, no P-touch Editor, no cloud. TapeDeck speaks the printer's raster
protocol directly over USB (libusb via node-usb) and renders every label in the app, so
what you see on the tape preview is exactly the bitmap the printer receives.

```
renderer (canvas, 180 dpi, 1-bit)  →  pixels over IPC  →  raster commands  →  libusb  →  PT-P700
```

## Install

Download the latest installer from
[Releases](https://github.com/Gene-Weaver/TapeDeck/releases/latest):

| Platform | File | Notes |
|----------|------|-------|
| macOS (Apple Silicon) | `TapeDeck-x.y.z-mac-arm64.dmg` | Unsigned: the first time, right-click the app → **Open** (or `xattr -cr /Applications/TapeDeck.app`). |
| macOS (Intel) | `TapeDeck-x.y.z-mac-x64.dmg` | Same as above. |
| Windows 10/11 (x64) | `TapeDeck-x.y.z-win-x64.exe` | Unsigned: SmartScreen shows "More info → Run anyway". Needs the WinUSB driver (below). |
| Linux (x64) | `TapeDeck-x.y.z-linux-x64.AppImage` or `.deb` | `chmod +x` the AppImage. Needs the udev rule (below). |

**Updates.** The app checks GitHub Releases on launch and every six hours (and from
*Help → Check for Updates*). Windows and the Linux AppImage download and install the update
in place and offer a restart. macOS builds are not code-signed, so macOS (and `.deb`
installs) are told an update exists and taken to the download page instead.

## Printer setup

1. Plug the PT-P700 in over USB and turn it on.
2. **Turn P-Lite off.** If the green P-Lite light is on, hold the P-Lite button for about
   two seconds. In P-Lite mode the printer pretends to be a USB drive and will not accept
   raster commands. In normal mode it is USB `04f9:2061`.
3. Platform specifics:
   - **macOS**: quit P-touch Editor and any Brother utilities so nothing else holds the USB
     interface. Nothing else is needed.
   - **Windows**: libusb needs the generic WinUSB driver bound to the printer. Run
     [Zadig](https://zadig.akeo.ie), *Options → List All Devices*, pick **PT-P700**, choose
     **WinUSB**, click *Replace Driver*. (To go back to Brother's driver later, uninstall the
     device in Device Manager and re-plug it.)
   - **Linux**: copy [`build/99-tapedeck-ptp700.rules`](build/99-tapedeck-ptp700.rules) to
     `/etc/udev/rules.d/`, then `sudo udevadm control --reload && sudo udevadm trigger`, and
     re-plug the printer.
4. The status pill at the top right should say `PT-P700 · 12 mm laminated tape` (or whatever
   cassette is loaded). Set the **Tape** selector to match; printing refuses to start when the
   loaded cassette differs from the job unless you disable that check in ⚙ settings.
5. Print one short label. If it comes out **upside down**, open ⚙ settings and tick
   **Flip pin order**. If it is **mirrored**, the mirror option is on.

No printer handy? ⚙ settings → **Mock printer** simulates one (or launch with `--mock`).

## Using it

| Tab | What it does |
|-----|--------------|
| **Single Text** | One label (or N copies). Font, bold/italic/invert, auto-fit height, border, auto or fixed length, padding live in the Style panel. |
| **Pattern** | *Prefix + counter + suffix* (`LEAF-0001` …) or a *template* with tokens: `{n}`, `{n:06}`, `{i}`, `{A}`/`{a}` letters, `{date}`, `{time}`. |
| **Batch** | Paste lines or a CSV/TSV (or load a file). With a header row, columns become tokens: `{name} #{id}`. |
| **Designer** | Drag-and-drop layout: text, photos (Floyd–Steinberg dithered), QR codes, Code 128 barcodes, boxes, lines. Rotation, centering, mm positioning. Save/load/export/import templates. |

The **Tape preview** dock at the bottom always shows every label that will print, to scale,
with margins and cut lines, plus the total tape length and an estimated print time. Tick
**Use Designer layout** to run Pattern or Batch values through your layout: any `{text}` or
`{n}` token in a Designer element is replaced per label.

**Print** (⌘/Ctrl+P) renders every label, sends the job, and opens the print theater: the
PT-P700 feeds each label out of its slot, the cutter snaps, and the label drops onto the
pile, in step with the real job's progress. **Export PNGs** saves the same bitmaps to a
folder you choose.

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

Source: Brother *Raster Command Reference, PT-H500/P700/E500*.

## Development

```bash
git clone https://github.com/Gene-Weaver/TapeDeck.git && cd TapeDeck
npm install
npm start            # or: npm run start:mock
npm test
npm run dist:mac     # dist:win, dist:linux — builds for the host platform into dist/
```

Releases are built by GitHub Actions ([build.yml](.github/workflows/build.yml)) on all
three platforms. Pushing to `main` builds installers as workflow artifacts; pushing a tag
publishes a GitHub Release that the in-app updater picks up:

```bash
npm version patch          # bumps package.json and creates the v0.1.x tag
git push && git push --tags
```

If you are running from a VS Code or Claude Code terminal, `ELECTRON_RUN_AS_NODE` may be
set in the environment; unset it before `npm start`.

## Repo layout

```
src/main/
  main.js             Electron app: window, menu, IPC handlers
  preload.js          contextBridge API exposed to the renderer (window.tapedeck)
  updater.js          electron-updater wiring (GitHub Releases)
  jobs.js             one-at-a-time print jobs with progress events
  ptouch/
    tapes.js          tape table (pins, margins)
    protocol.js       raster command builders, PackBits, job assembly
    status.js         32-byte status block parser
    transport.js      UsbTransport (node-usb) and MockTransport
    printer.js        status check, media validation, page-by-page printing
src/renderer/
  index.html, css/app.css
  js/app.js           state, tabs, tape preview strip, print flow
  js/api.js           IPC adapter + canvas → pixel buffer
  js/render.js        layout → 1-bit canvas (text, image dithering, QR, barcode)
  js/designer.js      drag-and-drop editor + properties panel
  js/printer-anim.js  the print theater
  js/pattern.js       counter / template / CSV expansion
  js/codes.js         Code 128 encoder, QR wrapper (vendor/qrcode.js, MIT)
tests/                node --test: protocol, mock printing, job manager, patterns
build/                icon, udev rule, mac entitlements
```

## Protocol notes

Per job: 100×`00` invalidate, `ESC @`, `ESC i a 01` (raster mode). Per page: `ESC i z`
print information (media width + raster line count), `ESC i M` (auto-cut, mirror),
`ESC i K` (chain printing off only on the last page so the tape is fed and cut at the end),
`ESC i A` cut-every-N, `ESC i d` margin (min 14 dots), `M 02` PackBits, then one `G`/`Z`
raster line per column and `FF` (more pages follow) or `^Z` (last page). Each raster line is
16 bytes; pin 0 is bit 7 of byte 0 and sits at the tape's bottom edge, which is why columns
are reversed before packing (`pixelsToRasterLines`).
