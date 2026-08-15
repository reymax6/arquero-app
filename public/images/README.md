# Gallery photos

Drop your resort photos in this folder and they'll appear in the app's gallery.
Use these filenames:

| Gallery tile      | Filename              |
|-------------------|-----------------------|
| Sunrise Deck      | `sunrise-deck.jpg`    |
| Court 1 at Dusk   | `court-dusk.jpg`      |
| Wood-Fired Pizza  | `wood-fired.jpg`      |
| Ridge Trail View  | `ridge-trail.jpg`     |
| Doubles Match     | `doubles-match.jpg`   |
| Terrace Dining    | `terrace-dining.jpg`  |

Square images around 900×900 look best. `.jpg`, `.png`, `.webp` and `.avif`
all work.

Nothing needs configuring. The server reports which photos are actually here,
so a tile you haven't replaced keeps its colour rather than showing a broken
image — you can add them one at a time.

To change the tiles or their captions, edit the `GALLERY` list near the bottom
of `public/app.js`.
