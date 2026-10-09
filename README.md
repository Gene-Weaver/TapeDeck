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

The window has two cards and a dock.

**Labels** (left) decides *what* gets printed:

| Mode | What it does |
|------|--------------|
| **Pattern** | A series built from segments, e.g. `{Project}-{Number}-{Letter}` = `UM-001-A … UM-052-C`. Segments are fixed text, a number range (zero-padded) or a letter range (`A→C`, `AA→BZ`; a lowercase start gives lowercase letters). The last segment cycles fastest. *Print labels from … to …* picks a slice of the series. |
| **Text** | One text, any number of copies. |
| **List** | One label per line, or a CSV/TSV (paste it, load a file, or drop the file on the window). With a header row, columns become tokens: `{name} #{id}`. |

**Layout** (right) decides *how* each label looks; see [Layouts](#layouts).

The **Tape preview** dock always shows every label that will print, to scale, with feed
margins and cut lines, plus the total tape length and an estimated print time.

**Print** (⌘/Ctrl+P) renders every label, sends the job, and opens the print theater: the
PT-P700 feeds each label out of its slot, the cutter snaps, and the label drops into the
tray, in step with the real job. Nothing prints until you press Print. **Export PNGs** saves
the same bitmaps to a folder you choose.

## Layouts

A layout is a list of elements: text, QR codes, Code 128 barcodes, photos (dithered to black
and white), boxes and lines. Text and codes can use tokens: `{text}` is the label's value,
pattern segments are `{Project}`, `{Number}`, … and list columns are `{c1}` or their header
names. `{n}`, `{i}`, `{date}` and `{time}` work everywhere.

TapeDeck ships two layouts:

- **Label wrap** (the default): QR · name · 10 mm black fold box · name · QR. Wrap the label
  around a rod at the box so it sticks to itself and reads from both sides.
- **Plain**: just the name, centered.

### Designing

- **Elements sit in a row.** They are laid out left to right in list order, so they never
  overlap and everything adjusts on its own: make the fold box wider, type a longer name, or
  switch to a wider tape and the rest moves along. Heights can follow the tape (*Full tape
  height*) and text can *Fit tape height*, so one layout works on 6 mm and 24 mm tape alike.
- **Drag an element** along the label to move it to another slot; the others make room as you
  go. Dragging up or down snaps to the tape's top, center and bottom.
- **Drag the gap** between two elements to change that spacing (hold ⌥ to change every gap,
  i.e. the layout's *Spacing*).
- **Handles resize.** Widths of row elements snap to 0.5 mm steps, heights snap to the full
  tape height.
- **Free elements** (Placement → *Free*) ignore the row and can go anywhere, for example a
  frame over other elements. While dragging they snap to the label's ends and center, the
  tape's edges and center, and the edges and centers of every other element; magenta guides
  show what snapped. Snapping to a center keeps the element centered when things change.
  *Put free elements in the row* turns free elements back into row elements, in the order
  they sit.
- **The Elements list** shows the row from left (top) to right (bottom); later elements are
  drawn on top. Drag a row of the list to reorder, click the eye to hide an element without
  deleting it.
- Text boxes can **fit their text**, have a **fixed width**, or be the **same width for all
  labels** (sized for the widest value in the whole series, so every label in a run lines up
  identically; Label wrap uses this).
- A layout can **fit its content** or have a **fixed length**; with a fixed length the row can
  sit at the start, center or end, or be spread out.

Shortcuts (after clicking in the layout card): ←/→ move the selected row element one slot
(free elements: nudge 1 dot, ⇧ 1 mm), ↑/↓ nudge, ⌫ delete, ⌘D duplicate, Esc deselect,
⌘Z / ⇧⌘Z undo and redo, ⇧ while dragging keeps the move straight, ⌥ while dragging turns
snapping off. Pinch or ⌘-scroll zooms the label; *Fit* (or a double-click on an empty spot)
shows all of it. Double-click an element to edit its text. Drop an image on the label to add
a photo at that spot.

### Where layouts are saved

Every change is saved automatically. Layouts are plain JSON files, one per layout, in the
per-user data folder, together with `settings.json` for everything else (tape width, label
inputs, printer options):

| Platform | Folder |
|----------|--------|
| macOS | `~/Library/Application Support/TapeDeck/` |
| Windows | `%APPDATA%\TapeDeck\` |
| Linux | `~/.config/TapeDeck/` |

Layouts are in its `layouts/` subfolder (*Show layouts folder* in the layout menu ⋯, or the
link in ⚙ settings). Updating or reinstalling TapeDeck never touches this folder. The
built-in layouts are copied into it once; after that they are yours to edit, and a newer
release will not overwrite them (*Revert to built-in version* brings back the shipped one,
*Restore built-in layouts* re-creates any you deleted). Deleted layouts go to the Trash.

The ⋯ menu also has New, Duplicate, Rename, Import and Export. You can drop a layout `.json`
on the window to import it, and edit the files by hand: TapeDeck notices when a file changes
while it is open (when its window regains focus).

The file format, in millimeters and points:

```json
{
  "format": "tapedeck-layout", "version": 2, "name": "Label wrap",
  "units": { "length": "mm", "fontSize": "pt" },
  "length": { "mode": "auto", "fixed": 40 },
  "padding": 0.5, "gap": 1.25, "justify": "start", "border": false,
  "elements": [
    { "type": "qr", "text": "{text}", "fullHeight": true, "ecc": "M", "quiet": 0, "vCenter": true },
    { "type": "text", "text": "{text}", "font": "Helvetica", "bold": true, "autoSize": true, "widthMode": "series", "vCenter": true },
    { "type": "rect", "name": "Fold box", "w": 10, "fullHeight": true, "fill": true, "spaceBefore": 0.6, "spaceAfter": 0.6, "vCenter": true }
  ]
}
```

Row elements use `spaceBefore` / `spaceAfter` on top of the layout's `gap`; free elements have
`"free": true` and an `x` (or `"hCenter": true`). Any element can have `"vCenter": false` and a
`y`, a `"rotate"` of 90, 180 or 270, and `"hidden": true`. Layouts exported by TapeDeck 0.1 can
be imported; they come in as free elements in the same positions.

## Tape geometry

Dots at 180 dpi (7.09 dots/mm). The whole tape width is printable (verified on a PT-P700), so
the band is the tape width in dots, centered on the 128-pin head and shifted by the vertical
offset calibration in ⚙ settings.

| Tape | Printable dots | Printable height |
|------|---------------:|-----------------:|
| 3.5 mm | 24 | 3.4 mm |
| 6 mm | 42 | 5.9 mm |
| 9 mm | 63 | 8.9 mm |
| 12 mm | 85 | 12.0 mm |
| 18 mm | 127 | 17.9 mm |
| 24 mm | 128 | 18.1 mm (head limit) |

Brother's *Raster Command Reference, PT-H500/P700/E500* lists narrower print areas (6 mm = 32
dots); those are only safe margins.

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
set in the environment; unset it before `npm start`. `TAPEDECK_USER_DATA=/some/dir` runs
TapeDeck with a separate settings/layouts folder (handy for testing next to a real setup).

## Repo layout

```
src/main/
  main.js             Electron app: window, menu, IPC handlers, USB access lock
  preload.js          contextBridge API exposed to the renderer (window.tapedeck)
  store.js            settings.json and layouts/*.json in the user data folder
  updater.js          electron-updater wiring (GitHub Releases)
  jobs.js             one-at-a-time print jobs with progress events
  ptouch/
    tapes.js          tape table (pins, margins)
    protocol.js       raster command builders, PackBits, job assembly
    status.js         32-byte status block parser
    transport.js      UsbTransport (node-usb) and MockTransport
    printer.js        status check, media validation, page-by-page printing
src/presets/          built-in layouts (copied into the user's layouts folder once)
src/renderer/
  index.html, css/app.css
  js/app.js           settings, label inputs, tape preview strip, print flow, wiring
  js/api.js           IPC adapter + canvas → pixel buffer
  js/layout.js        layout model: row/free placement, snapping, file format (no DOM)
  js/render.js        layout → 1-bit canvas (text, image dithering, QR, barcode)
  js/designer.js      the layout canvas: select, drag, snap, resize, keyboard
  js/panel.js         element list (drag to reorder), layout and element properties
  js/library.js       layout files: open, autosave, new, rename, import, export
  js/history.js       undo / redo
  js/printer-anim.js  the print theater
  js/pattern.js       segment patterns, tokens, CSV
  js/codes.js         Code 128 encoder, QR wrapper (vendor/qrcode.js, MIT)
tests/                node --test: protocol, mock printing, jobs, patterns, layouts, file store
build/                icon, udev rule, mac entitlements
```

## Protocol notes

Per job: 200×`00` invalidate (the spec asks for 100; 200 also flushes a half-sent raster line), `ESC @`, `ESC i a 01` (raster mode). Per page: `ESC i z`
print information (media width + raster line count), `ESC i M` (auto-cut, mirror),
`ESC i K` (chain printing off only on the last page so the tape is fed and cut at the end),
`ESC i A` cut-every-N, `ESC i d` margin (min 14 dots), `M 02` PackBits, then one `G`/`Z`
raster line per column and `FF` (more pages follow) or `^Z` (last page). Each raster line is
16 bytes; pin 0 is bit 7 of byte 0 and sits at the tape's bottom edge, which is why columns
are reversed before packing (`pixelsToRasterLines`).
