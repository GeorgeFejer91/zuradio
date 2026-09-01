# Zuradio application icon

`zuradio-widget.png` is the 1024 × 1024 production master for the launcher,
taskbar, installer, and mobile icons. Its monochrome portrait is derived from
the active Zuri Linux boot identity; the radio signal in the right lens makes
the mark specific to Zuradio while keeping it readable at 16–32 px.

The source palette is `#090909` and `#f4f2e9`, with transparent rounded
corners. Regenerate the checked-in Tauri platform matrix from the repository
root with:

```sh
cargo tauri icon packaging/icons/zuradio-widget.png \
  --output apps/zuradio-desktop/src-tauri/icons \
  --ios-color '#090909'
```

The local Linux installer uses the generated 512 px `icon.png` for the hicolor
launcher icon. Do not resize or recolor individual generated files by hand.
