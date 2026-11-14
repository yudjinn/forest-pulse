# Forest Pulse shared brand assets

This directory is the shared brand asset source for the Forest Pulse webapp and
Arduino project. Web formats below are for the webapp; the Arduino deployment
does not need an image bundle.
The approved leaf and pulse shape is preserved. `mark.svg` and `logo.svg` are the
editable masters; every derivative is rebuilt from their paths. The original
explorations in `design/` are historical artwork.

## Files

| Asset | Use |
| --- | --- |
| `mark.svg`, `mark-inverse.svg` | Transparent leaf mark in evergreen or ivory |
| `logo.svg`, `logo-inverse.svg` | Transparent stacked logo with outlined lettering |
| `logo-horizontal.svg`, `logo-horizontal-inverse.svg` | Compact logo for app headers |
| `icons/favicon.svg` | Scalable favicon with an ivory background for light and dark browser chrome |
| `icons/favicon.ico` | Legacy favicon containing 16, 32 and 48 px images |
| `icons/favicon-{16,32,48}.png` | PNG favicon fallbacks |
| `icons/apple-touch-icon.png` | Opaque 180 px Apple home screen icon |
| `icons/icon-{192,512}.png` | Standard PWA icons |
| `icons/maskable-{192,512}.png` | PWA icons with extra padding for platform masks |
| `social/og-image.png` | 1200 x 630 social sharing image |
| `social/og-image.svg` | Editable vector source for the social image |
| `site.webmanifest` | Manifest template for an app served from the origin root |
| `head.html` | Favicon and manifest tags assuming assets are served at `/brand/` |
| `preview.svg`, `preview.png` | Asset contact sheet |

Evergreen: `#0B4827`. Ivory: `#FBF7EF`. Logo SVGs contain paths only, with no
embedded bitmap, font dependency, or external resource. App icons have square,
opaque backgrounds; the operating system supplies the final corner shape.
Maskable artwork stays within the central circular safe zone specified by the
[Web Application Manifest standard](https://www.w3.org/TR/appmanifest/#icon-masks).

## Use in a webapp

At build time, copy the SVGs, `icons/`, and `social/` from this directory into the
app's public `brand/` directory. Keep this folder as the source; regenerate here
rather than independently editing copies. A Python webapp can mount this
directory at `/brand` using its static-file middleware.

Add the tags from `head.html` to the page head. Set a useful `alt` on logo images,
or `alt=""` when nearby text already supplies the same name.

Copy `site.webmanifest` into the public `brand/` directory.
Its icon paths resolve relative to the manifest, so the `icons/` folder must stay
beside it. The manifest assumes the webapp runs at the origin root. Adjust
`id`, `start_url`, and `scope` if it runs under a subpath, and update the HTML
paths if the assets are served somewhere other than `/brand/`.

For social previews, use the deployed **absolute HTTPS URL** of
`/brand/social/og-image.png` for both `og:image` and `twitter:image`. Set
`og:image:width` to `1200`, `og:image:height` to `630`, and `twitter:card` to
`summary_large_image`. Supply the webapp's title, description, and canonical
URL. These assets do not add offline behaviour or a service worker.

## Regenerate

Requires Python 3, librsvg (`rsvg-convert`), and ImageMagick (`magick`). On macOS:

```sh
brew install librsvg imagemagick
python3 shared/assets/forest-pulse/generate.py
```

The generator works from any current directory. It reads only `mark.svg` and
`logo.svg` as artwork inputs and overwrites the derived assets in this folder.
Edit the masters to change the artwork, or the generator to change sizes,
colours, padding, and the manifest template. Keep the masters' existing coordinate
systems when editing their paths, since the generator uses those coordinates to
center and scale the artwork.
