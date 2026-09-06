# Lens Bench prescriptions

Lens Bench is an audio-reactive meridional ray visualization, not an optical
qualification tool. It uses spherical surfaces, vector Snell refraction, and
clear-aperture clipping, and traces five field points at once — each bundle
aimed through the aperture stop (see *Field points and pupil aiming*). The
optics live in `ui/src/viz/modes/lens-bench/optics.ts`; the mode that draws
them in `ui/src/viz/modes/lens-bench.ts`. The reference lane uses the d-line refractive index;
the two color lanes use the glass's own F and C indices derived from its Abbe
number (n_F = n_d + 0.69·(n_d−1)/V_d, n_C = n_d − 0.31·(n_d−1)/V_d — the
d line sits about 31% up from C to F for normal glasses), so an achromat's
lanes land together and a singlet's fan out. The music only fades the lanes;
it never changes the glass. Coatings, absorption, diffraction, and Fresnel
losses are not simulated.

## Nothing typed in decides focus

Every bench number is derived from the prescription at load
(`prepareDesign` in `ui/src/viz/modes/lens-bench/optics.ts`):

- **EFL.** A design declares its published focal length; the surfaces are
  scaled uniformly so the paraxial trace agrees with it (scaling every length
  by k scales EFL by k and keeps the aberration shape).
- **Image plane.** Focusing designs get their last air gap set to the *best
  focus*: the on-axis fan at full aperture is traced once and the RMS spot is
  scanned along the bench; its minimum is the circle of least confusion,
  which sits ahead of the paraxial focus by the lens's spherical aberration
  (0.6 mm on the achromat). The original
  achromat fixture had a typed image distance 7 mm past focus — the "IMG"
  line showed a blur, not a spot. The two Zemax samples ship at best focus
  already, and the scan lands within 0.03 mm of their own image distances.
- **Focus marker.** The same scan finds an *internal* focus for an afocal
  instrument (the Keplerian's crossing between the lenses, 50.9 mm in; the
  riflescope's first image behind its objective, 103.6 mm in) and the
  bloom and note-arrival flare sit there while the screen still shows the
  collimated output. A fan that never converges gets no focus at all.
- **Fan height.** Bisection on the real trace finds the tallest on-axis ray
  that clears every clear aperture (backed off by 0.2% so the rim ray
  survives single-precision storage), then the published f-number caps it
  (the achromat's fixture apertures would pass f/4 exactly; the Zemax
  samples' f/5 and f/2.99 are their entrance-pupil diameters; an afocal
  instrument is capped by its objective diameter instead). The low
  band swings the pupil between 70% and 100% of that, so the loudest state is
  the lens wide open with no vignetting on axis.
- **Readouts.** The title strip shows the traced EFL, BFL and working
  f-number, the design's half-field, and — for focusing designs — the
  distortion and tangential field curvature at the full field; afocal
  designs show AFOCAL with the traced magnification (exit over entrance
  beam height, negative when inverting).
- **Exit pupil.** An afocal instrument flagged `exitPupil` gets its screen
  where the paraxial chief ray crosses the axis behind the eyepiece — the
  eye's position, 49.9 mm behind the riflescope's eyepiece — so every
  field's bundle converges onto the same disc there.

| Design | Scale k | EFL | Paraxial BFL | Fan cap | Best focus from last vertex | RMS spot paraxial → best |
|---|---|---|---|---|---|---|
| Achromat doublet | 1.085 | 100.0 | 96.81 | f/4 (h 12.5) | 96.25 | 0.049 → 0.019 mm |
| Cooke triplet | 1.000 | 50.0 | 42.42 | f/5 (h 5.0) | 42.22 (sample: 42.21) | 0.013 → 0.004 mm |
| Double Gauss | 1.000 | 99.5 | 57.50 | f/2.99 (h 16.67) | 57.28 (sample: 57.31) | 0.024 → 0.008 mm |
| Riflescope 4×17 | — | afocal, 3.9× | — | 17 mm objective (h 8.5) | internal, z 103.6 | 0.007 mm |
| Telephoto | 1.000 | 200.0 | 50.00 | clear aperture, f/7.3 | 47.67 | 0.10 → 0.040 mm |
| Keplerian pair | — | afocal | — | clear aperture | internal, z 50.85 | 0.14 mm |

## Field points and pupil aiming

Five field points are traced every frame, at −1, −0.6, 0, +0.6 and +1 of the
design's `maxFieldDeg` — each a collimated bundle entering at that field
angle. The angles are the design's own field points and never move with the
music; the mid band lights the off-axis bundles up instead. The ± pairs are
the same field point seen from both sides of the axis and share a colour
(axis in the drafting text colour, 0.6 field violet, full field yellow), so
the bench reads like a layout plot with the chief rays crossing in an X at
the stop.

- **Stop.** The surface flagged `stop`, else the front surface. `stopHalf` is
  the height at the stop of the on-axis ray launched at the fan height: the
  working pupil, expressed where the stop is, so every field samples the same
  aperture (Double Gauss: 9.95 mm at the stop for the f/2.99 fan against a
  10.23 mm stop semi-diameter; Zemax reports the same stop radius, 9.997).
- **Aiming.** For each field two reference rays, seeded from the paraxial map
  `y_stop = M·y₁ + N·u` (M, N traced once per design), fix an affine
  launch-height map `y₁(y_stop)`; eleven rays are launched at pupil
  coordinates p·stopHalf·fill for p ∈ [−1, 1], and one secant step puts the
  chief ray through the stop centre to better than a micron. The map is exact
  to aberration level (≤0.11 mm at the stop on the Cooke, 0.36 mm at 14° on
  the Double Gauss). If a reference ray dies before the stop
  the paraxial map is used for that frame, so no field is ever empty. The F
  and C lanes reuse the d-line launch heights: a white-light entry ray
  disperses, a bench aims at d.
- **Vignetting.** Rays that clip elsewhere die exactly as on axis (dimmed
  stubs). Off axis that is the real vignetting of the design: the Double
  Gauss loses a rim ray at 14° exactly as the Zemax sample does, the Cooke
  passes its whole f/5 pupil out to 20°, the telephoto loses a rim ray at
  its rear singlet, and the riflescope loses two at its field edge in the
  eyepiece.
- **Tangential focus.** Per field, in closed form: with each surviving ray's
  exit segment `y = a + b·z`, the spread across rays is quadratic in z and its
  minimum is `z* = −cov(a, b) / var(b)`. It is rejected when fewer than three
  rays survive, the exit is collimated, or z* lands more than 0.35·zImg from
  the design's own focus; an afocal instrument fits the segment that
  straddles its internal crossing instead. The dotted curve through the five foci
  is the tangential field curvature, drawn straight on the bench. It is the
  RMS minimum of the live meridional fan, not a Coddington trace, and it
  moves with the pupil fill (the low band) because the circle of least
  confusion of an aberrated fan is aperture-dependent; the numbers below
  are at full fill. At full field it reads −0.48 mm (achromat, 3°), +0.17
  (Cooke, 20°), −0.05 (Double Gauss, 14°) and −0.99 (telephoto, 2.5°) —
  the two anastigmats are flat-field designs, the telephoto is not, and the
  bench shows both. Beware reading the number on
  a fan that has lost its rim ray: the circle of least confusion then
  carries less spherical aberration and shifts, which is not field
  curvature. T-CURV and DIST on the strip are teaching readouts, not
  qualification data.
- **Distortion.** The chief ray's landing height against the paraxial chief
  ray's at the bench's *actual* image plane (`chiefGain` per unit slope, traced
  at load). `efl·tan θ` is the wrong baseline here: the image plane sits ahead
  of paraxial focus by the spherical aberration, and naive f·tanθ would
  read percent-level "distortion" on a fast singlet that has none. The Double Gauss
  reads −0.87% (barrel) at 14°, the Cooke +0.07% at 20°, the telephoto
  +0.91% (pincushion, the telephoto signature) at 2.5°. Ticks at IMG show
  the ideal and actual chief-ray heights; the F/C chief rays sit beside them
  while the highs hold the lanes open (lateral colour).
- **Ray-fan inset.** On canvases 560×360 and larger, three panels bottom-left
  plot transverse aberration ε_y = y_img(p) − y_img(chief) against pupil
  coordinate for the axis, 0.6 and full field, one curve per lane on a shared
  scale that is printed. Spherical reads as a cubic, coma as an S, lateral
  colour as the F/C curves offset from the d line.
- **Pulses.** Each pattern track rides the field `slot mod 5`, so instruments
  travel different bundles; kicks flood the on-axis marginal pair and chief,
  snares fire the two full-field chief rays through the stop centre, and each
  field blooms at its own focus when its rays arrive.

## Photographic objectives (Zemax samples, replaced September 6, 2026)

The original Cooke and Double Gauss entries were rustoptic import fixtures
that an optical review found not to be what their labels said (a five-surface
"triplet" with a cemented rear, a "Double Gauss" with the stop buried inside
the front flint and no rear flint). Both were replaced with the sample
prescriptions that ship with Zemax OpticStudio under
`Samples/Sequential/Objectives`, read from public mirrors of the files:

- **Cooke triplet** — `Cooke 40 degree field.zmx`
  ([mirror](https://github.com/xzos/PyZDDE/blob/master/ZMXFILES/Cooke_40_degree_field.zmx)).
  Radii +22.0136 / −435.760 / −22.2133 / +20.2919 / +79.6836 / −18.3953,
  thicknesses 3.259 / 6.008 / 1.000 / 4.750 / 2.952 / 42.208, SK16 / F2 /
  SK16, semi-diameters 9.5 / 9.5 / 5 / 5 / 7.5 / 7.5, stop on the flint's
  rear face, entrance pupil 10 mm (f/5), fields 0 / 14 / 20°. Paraxial EFL
  traces to 50.02.
- **Double Gauss** — `Double Gauss 28 degree field.zmx`
  ([mirror with Zemax's own report](https://github.com/fmannan/LensSimulator/blob/master/LensPrescription/DGauss28DegField_Zemax.txt)).
  Radii +54.153 / +152.522 / +35.951 / ∞ / +22.27 / stop / −25.685 / ∞ /
  −36.98 / +196.417 / −67.148, thicknesses 8.747 / 0.5 / 14.0 / 3.777 /
  14.253 / 12.428 / 3.777 / 10.834 / 0.5 / 6.858 / 57.305, N-SK2 / N-SK16 /
  F5 / F5 / N-SK16 / N-SK16, semi-diameters half the sample's surface
  diameters, entrance pupil 33.33 mm, half field 14°. Zemax reports EFL
  99.50068, BFL 57.49797, working f/2.98; the bench's paraxial trace gives
  99.50 / 57.50. Current OpticStudio releases ship a different lens under
  the same name (an f/2 re-optimization: +56.20 / +152.29 / +37.68 / ∞ /
  +24.23 / stop / −28.38 / ∞ / −37.93 / +177.41 / −79.41, N-SSK2 / N-SK2 /
  F5, EFL 100.00, BFL 61.49 per O'Shea & Bentley, *Designing Optics Using
  Zemax OpticStudio*, Table 4.2); the older release is used here because
  its surface diameters are published, which the off-axis vignetting
  depends on. The retired fixture's 37.68 radius and N-SSK2 came from that
  newer variant.

Glass constants are Schott catalog values at the d line: SK16 1.62041 /
60.32, F2 1.62004 / 36.37, N-SK2 1.60738 / 56.65, F5 1.60342 / 38.03.

## Added designs (researched September 4, 2026)

Dimensions below are millimetres. Radius signs follow light travelling left to
right: positive means the centre of curvature lies to the right of the vertex.
Zero radius in code means a plane. Apertures use half the published **clear
aperture**, not half the mechanical diameter. Final distances locate either a
nominal image plane or an explicitly labelled observation screen.

### Riflescope 4×17 — derived assembly (replaced the condenser, September 6, 2026)

The Edmund PCX condenser (EO 70-265) that held this slot was traced
correctly — its marginal rays crossed the axis 5 mm ahead of the paraxial
ones — but an f/1.35 singlet is a light collector, not an imager, and on the
bench it read as broken. It was replaced with an instrument that shows the
trace off: a 4× riflescope built entirely from the Fraunhofer achromat form
scaled by the paraxial trace (`riflescope()` in `optics.ts`):

- **Objective:** the form scaled to EFL 100, 17 mm entrance pupil (f/5.9),
  the aperture stop.
- **Erector:** two f=50 doublets, 20 mm apart, the first with its front
  focal point on the objective's image, so the relay is afocal between them
  and re-forms an erect image behind the second.
- **Eyepiece:** a Plössl — two f=50 doublets, flint sides outward, 2 mm
  apart (EFL 25.9) — with its front focal point on the erected image.
- **Screen:** at the exit pupil, solved from the paraxial chief ray, 49.9 mm
  behind the eyepiece; the 4.4 mm exit beam is what the eye receives.

Every gap is a paraxial solve (group BFL plus the next group's FFD), nothing
is typed in, and the whole train is afocal to rounding with magnification
+3.86 (erect). Field ±1.5°, what a real 4× scope sees; the erector and
eyepiece diameters are limited by the form's edge thickness, and that is
what vignettes the rim rays at the field edge. Fifteen surfaces, so the
polyline stride is 18 points per ray.

### Telephoto 200mm — derived assembly (replaced the diverging fan, September 6, 2026)

The EO 45-028 plano-concave singlet held this slot on its own as a
"diverging fan" with a virtual focus behind it — a correct trace of a lens
that forms no image, and nothing to look at. The same element now does the
job a concave lens is bought for (`telephoto()` in `optics.ts`):

Source: [Edmund Optics 25mm diameter, −50mm focal length PCV lens](https://www.edmundoptics.com/p/250mm-dia-x50-fl-uncoated-plano-concave-lens/5540/).
Published geometry: radius −25.84, planar rear, centre thickness 3.50,
clear aperture 24.00, N-BK7, EFL −50.00.

- **Front group:** the Fraunhofer form at EFL 100, the aperture stop.
- **Rear group:** the EO 45-028 with its plane toward the converging light
  and the concave face toward the image, placed by bisection on the
  paraxial trace at the separation (69.5 mm) that stretches the pair to
  EFL 200.
- Result: EFL 200.0, BFL 50.0, working f/7.3 at the achromat's clear
  aperture, 127.7 mm from front vertex to image — a lens 0.64 times as
  long as its focal length, which is what a negative rear group buys. The
  flint-free rear singlet leaves lateral colour the F/C lanes show, and
  the field is curved (−0.99 mm at 2.5°) with +0.9% pincushion, both the
  honest signature of the form.

### Keplerian crossover — derived assembly

Sources: [Edmund Optics EO 47-368 double-convex singlet](https://www.edmundoptics.com/p/25mm-dia-x-50mm-fl-vis-0deg-coated-double-convex-lens/7425/)
and [Edmund Optics beam-expander principles](https://www.edmundoptics.com/knowledge-center/application-notes/lasers/beam-expanders/).

Each of the two identical N-BK7 singlets has radii +50.80/−50.80, centre
thickness 5.00, clear aperture 24.00, EFL 50.00, and BFL 48.29.
The assembly is our derived 1× inverting Keplerian arrangement, **not a
manufacturer-specified complete instrument**. With symmetric singlets, the
rear focal distance of the first equals the front focal distance of the
second. The chosen vertex-to-vertex air gap is therefore 2 × 48.29 = 96.58.
Rays cross between the lenses and leave approximately collimated in the
paraxial reference lane. Stronger marginal rays and exaggerated color lanes
retain aberration. A screen 40mm after the second lens shows the output bundle;
it is not labelled a focus. The field is limited to ±1° to reduce vignetting.

### Glass constants

[SCHOTT N-BK7 glass data](https://www.schott.com/en-gb/products/optical-glass/-/media/Project/OnEx/Products/optical-glass/Downloads/schott-optical-glass-collection-datasheets-english-may2019.pdf?rev=5358bb64e13a44f2b37f5065490509af)
gives n_d = 1.51680 and V_d = 64.17; all three added designs use these values.

## Integration and validation

The riflescope, telephoto and Keplerian follow the achromat, Cooke, and
Double Gauss in the 16-bar rotation. The title block shows the current design number. The
achromat retains its original fixture data; the Cooke and Double Gauss are
the Zemax samples above.

All six designs stay within the 165-ray / 18-point buffers (3 lanes × 5
fields × 11 rays; the riflescope's 15 surfaces need 17 points per ray). The original numerical checks covered three viewport
sizes, low/mid/high extremes, and both field limits: 648 render scenarios
with finite coordinates, 15/15 reference rays on axis at the quiet aperture
setting. The field-point work was checked by tracing every design at full
spread and full pupil: every field keeps at least 9 of 11 d-line rays, every
chief ray crosses the stop centre to <1e-3 mm, every focusing design has a
finite tangential focus for all five fields, and distortion stays under
0.3%. Additional checks
confirmed axis crossing and nearly parallel paraxial output for the Keplerian
pair, and no focal-gradient rendering at the screen of afocal designs. The checks stubbed audio scheduling and canvas rasterization;
they do not establish live frame rate or optical manufacturing accuracy.
