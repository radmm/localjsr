# H2S Badge Reader

## Color-reading pipeline

- Camera captures use the on-screen badge guide as a source-pixel crop. Uploaded photos require a user-drawn crop before analysis.
- `ROI_LAYOUT` in `app.js` is the versioned badge-relative source for the strip, six reference swatches, and sealed reference ROI. Each rectangle is inset by 25% on every side before sampling.
- ROI colors are per-channel pixel medians. Camera captures keep three frames, reject the most-distant frame per ROI, then take the median of the remaining two.
- Captures are refused for non-uniform patches (initial max channel standard deviation `24`), clipping above `2%`, Laplacian variance below `20`, strip/background similarity below `10 RGB`, or the existing reference-fit residual above `32 RGB RMS`.
- Those gate thresholds are initial engineering values and have not been tuned against field captures. The ROI positions carry forward the app's assumed badge layout and also need confirmation against printed badges.
- Successful `v1.6` records store ROI medians, ROI layout version, and a small cropped badge thumbnail. Older records retain their original version and are marked as legacy; they are never rewritten.
- Run the synthetic regression and gate tests with `node tests.js`.

All capture, correction, gating, and record storage run locally without a network dependency.
