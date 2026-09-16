# H2S Badge Reader

## Color-reading pipeline

- The badge uses six fixed-position printed reference swatches across multiple hues, not a three-point grayscale reference.
- Capture requests manual auto-exposure and auto-white-balance modes when the camera platform exposes those controls. The browser preview reports whether the lock was applied.
- Each capture samples three consecutive frames. For the strip and every reference patch, the frame furthest from the other two is rejected before averaging.
- A per-photo RGB correction is fitted against all six known references. Captures over the `32 RGB RMS` residual threshold are refused with `Retake photo`; no dose record is saved.
- Saved records include `analysisVersion`. The current profile is `v1.5`; bump it whenever the offline calibration notebook produces new dose-regression coefficients.
- Calibration is an ongoing lab workflow. New exposure samples should be added at the low-concentration end before refitting, where the color response is least linear.

All capture, correction, gating, and record storage run locally without a network dependency.
