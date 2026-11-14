# Bucket data

The stored files the service reads from its private R2 bucket (binding `STORAGE`),
committed here and mirrored into the bucket by relative path: `player/owl.wav`
here is the object `player/owl.wav`.

- `npm run deploy` uploads every file here to the live bucket.
- `npm run serve` and the journeys seed the same files into fresh local storage.

Uploads overwrite objects of the same name and never delete anything, because the
service also writes its own objects to the bucket. To remove an object from the
live bucket, delete it there by hand (`npx wrangler r2 object delete
forest-pulse/<key> --remote --jurisdiction eu`) as well as from this folder.

Each area keeps its files in its own subfolder. The content type is set from the
extension (`.wav`, `.mp3`, `.ogg`, `.json`, `.txt`, `.md`, `.csv`); other files are
stored without one. This README and dotfiles are never uploaded.
