# App wallpaper

## Problem
You can customize sr03's look only through a theme (a color palette), light/dark mode, and fonts.
Every surface is a solid theme color, so you can't make the workspace personal with an image.
This comes up whenever you want the app to feel like your own space rather than a stock palette.

## Goal
You can set one image from disk as the background of the whole app window. The sidebar, the
editor groups, the file tree and the other panels sit on top of it as translucent, blurred
surfaces, and three sliders tune how the result looks.

## Non-goals
- Animated wallpapers: no GIF animation and no video. A still frame of an animated file is fine,
  but it is not a promise.
- A different wallpaper per project or per thread. There is one global wallpaper.
- Separate images for light and dark mode.
- A library or history of past wallpapers. Uploading a new image replaces the old one.
- Wallpapers from a URL, and bundled or preset wallpapers.
- Making menus, popovers, dialogs, tooltips or the command palette translucent. These overlays
  stay opaque so they remain readable.
- Changing any theme's palette. The wallpaper changes how translucent the surfaces are, not
  their colors.

## Behaviour
The appearance panel gains a **Wallpaper** section beneath the theme and font pickers. With no
wallpaper set, it shows a "Choose image…" button and nothing else, and the app looks exactly as
it does today.

When you choose an image (PNG, JPEG or WebP), it uploads to the sr03 server, which keeps it with
the rest of sr03's data. The image then fills the window behind everything, scaled to cover and
centered. The panels' backgrounds turn translucent in the current theme's color and blur what is
behind them, so the wallpaper shows through while text stays readable. The section now shows a
thumbnail of the image, **Replace** and **Remove** buttons, and three sliders:

- **Panel opacity**: how solid the panel surfaces are, from mostly see-through to fully opaque.
- **Wallpaper blur**: how blurred the image itself is, from sharp to heavily blurred.
- **Dim**: an overlay that darkens the image in dark mode and lightens it in light mode, from
  none to heavy.

Slider changes apply live as you drag. Your wallpaper and slider values persist across reloads
and restarts, in the browser and in the desktop app, the same way the theme and fonts persist.
Switching theme or light/dark mode keeps the wallpaper and retints the translucent panels to
match the new theme.

**Remove** deletes the stored image and returns the app to its exact look from before the
wallpaper was set.

When something goes wrong:
- Choosing a file that isn't a PNG, JPEG or WebP, or that is over the size limit, shows an inline
  error in the Wallpaper section. The current wallpaper stays as it was.
- If the upload fails (server down, disk full), you get an inline error and the current wallpaper
  is unchanged.
- If the stored image is missing or can't be loaded at startup, the app renders as though no
  wallpaper is set, with opaque panels and no broken-image artifacts. The section offers
  "Choose image…" again.

## Acceptance criteria
1. When no wallpaper has ever been set, every surface has the same computed background it has
   before this change: no translucency and no backdrop blur anywhere.
2. When you choose a valid PNG, JPEG or WebP under the size limit, the image fills the whole
   window behind the sidebar, editor groups, file tree and terminal within one second of the
   upload finishing. No reload is needed.
3. While a wallpaper is set, the sidebar, editor group, file tree and terminal backgrounds are
   partly transparent and apply a backdrop blur, so the wallpaper is visible through each one.
4. While a wallpaper is set, menus, popovers, dialogs and tooltips keep fully opaque backgrounds.
5. When you move the panel opacity slider to its maximum, the panels are fully opaque. The
   wallpaper then shows only where no panel covers the window.
6. When you move the wallpaper blur slider, the blur on the image changes live. At 0 the image is
   sharp.
7. When you move the dim slider, the overlay changes live. At 0 there is no overlay. In dark mode
   the overlay darkens the image, and in light mode it lightens it.
8. When you reload the page, or quit and relaunch the desktop app, the same wallpaper and slider
   values are in effect.
9. When you switch theme or light/dark mode while a wallpaper is set, the wallpaper stays and the
   panel tint follows the new theme's colors.
10. When you click **Remove**, the server deletes the stored image and criterion 1 holds again.
11. When you choose a file of another type (for example a PDF or SVG), or a file over the size
    limit, the section shows an error naming the reason, and nothing is uploaded or stored.
12. When you choose a new image while one is already set, the old stored image is replaced, not
    kept alongside the new one.
13. When the stored image file has been deleted from disk behind sr03's back, startup renders
    with opaque panels and no wallpaper, and the section shows "Choose image…".

## Constraints
- The server takes no new dependencies (sr03's server budget is Node built-ins). The image is
  stored under sr03's data directory, so it moves with `SR03_DATA_DIR`.
- UI controls are shadcn/ui components, and colors come from the existing token set. There are
  no raw colors, except that the dim overlay is black or white at the chosen strength.
- The feature must work the same on the dev server and in the packaged desktop app, which serves
  the web build from its own server on a random port.
- Size limit: 20 MB per image. This covers a 5K photo and stops accidental multi-hundred-MB
  uploads.
- Scrolling and typing in the editor and terminal must not visibly stutter with a wallpaper set.
  The blur is a static layer, not recomputed on every scroll.

## Open questions
- Default slider values: proceeding with panel opacity 80%, wallpaper blur 0, dim 20%, tuned
  by eye once it's running.
- Terminal translucency: proceeding on the assumption that the terminal panel goes translucent
  like the others. If the terminal renderer can't draw a transparent background cheaply, the
  terminal stays opaque, and that gets flagged in review rather than worked around.
- Code and file previews (syntax-highlighted views, the diff view, mermaid and excalidraw):
  proceeding on the assumption that they inherit the panel translucency wherever they use the
  panel background, and keep their own background wherever they draw one themselves.
