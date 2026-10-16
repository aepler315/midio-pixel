# Drop your SoundFonts here

Put any `.sf2` or `.zip` (containing `.sf2` files) in this folder and refresh
the page — `tools/serve.js` exposes a `GET /soundfonts/` manifest that the
app fetches automatically on boot, so your fonts load with **zero clicks**:
no file picker, no directory-permission prompt.

```
soundfonts/
  MyOrchestra.sf2
  RetroSynths.zip
```

Once at least one font loads, the font name pill at the bottom of the
screen shows the active font — click it (or press **F**) to open a popup
listing every loaded SoundFont. Click a row to make it active, or click the
**×** on a font to hide it (excluded from the rotation, but never deleted).
Hidden fonts come back through the **settings gear** (top-right of the HUD)
or the popup's **Hidden (n)** link. Hover the pill to keep it open, or move
the mouse during play to bring it back.

You can still load fonts manually instead (or in addition) with the
**Load .sf2 / .zip**, **Folder**, and **Open directory…** controls on the
title screen — useful for one-off fonts you don't want to leave on disk, or
when this folder isn't reachable (e.g. you're serving the app from
somewhere other than `tools/serve.js`).

Your own `.sf2`/`.zip` files are gitignored — drop as many as you like, they
will never get committed.
