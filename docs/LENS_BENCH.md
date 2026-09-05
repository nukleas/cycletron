# Lens Bench prescriptions

Lens Bench is an audio-reactive meridional ray visualization, not an optical
qualification tool. It uses spherical surfaces, vector Snell refraction, and
clear-aperture clipping. The reference lane uses the d-line refractive index;
the two color lanes use the glass's own F and C indices derived from its Abbe
number (n_F = n_d + 0.69·(n_d−1)/V_d, n_C = n_d − 0.31·(n_d−1)/V_d — the
d line sits about 31% up from C to F for normal glasses), so an achromat's
lanes land together and a singlet's fan out. The music only fades the lanes;
it never changes the glass. Coatings, absorption, diffraction, and Fresnel
losses are not simulated.

## Nothing typed in decides focus

Every bench number is derived from the prescription at load
(`prepareDesign` in `ui/src/viz/modes/lens-bench.ts`):

- **EFL.** A design declares its published focal length; the surfaces are
  scaled uniformly so the paraxial trace agrees with it (scaling every length
  by k scales EFL by k and keeps the aberration shape).
- **Image plane.** Focusing designs get their last air gap set to the paraxial
  back focal distance. The three original fixtures had typed image distances
  7, 20 and 28 mm past focus — the "IMG" line showed a blur, not a spot.
- **Fan height.** Bisection on the real trace finds the tallest on-axis ray
  that clears every clear aperture, then the published f-number caps it
  (fixture stops are often oversized; the Double Gauss passes f/1.1). The low
  band swings the fan between 70% and 100% of that, so the loudest state is
  the lens wide open with no vignetting on axis.
- **Readouts.** The title strip shows the traced EFL, BFL and working
  f-number; screen designs show AFOCAL / their virtual EFL.

| Design | Scale k | EFL | BFL | Fan cap | Marginal d-line hit |
|---|---|---|---|---|---|
| Achromat doublet | 1.085 | 100.0 | 96.81 | f/4 (h 12.5) | ≈0.1 mm |
| Cooke triplet | 1.516 | 50.0 | 37.18 | f/4 (h 6.25) | ≈0.1 mm |
| Double Gauss | 1.832 | 50.0 | 22.18 | f/2 (h 12.5) | ≈0.6 mm |
| Fast condenser | 1.000 | 30.0 | 24.68 | clear aperture, f/1.35 | ≈2.7 mm (a single PCX this fast is a blur by nature) |

The condenser's f/1.2 label exceeds what its clear aperture passes, so the
trace's own marginal ray (f/1.35) is the limit there.

## Added designs (researched September 4, 2026)

Dimensions below are millimetres. Radius signs follow light travelling left to
right: positive means the centre of curvature lies to the right of the vertex.
Zero radius in code means a plane. Apertures use half the published **clear
aperture**, not half the mechanical diameter. Final distances locate either a
nominal image plane or an explicitly labelled observation screen.

### Fast condenser — EO 70-265

Source: [Edmund Optics 25mm diameter, 30mm focal length PCX lens](https://www.edmundoptics.com/p/25mm-dia-x-30mm-fl-swir-coated-n-bk7-pcx-lens/53967/).

Published geometry: front radius +15.50, planar rear, centre thickness 8.06,
clear aperture 22.20, N-BK7, EFL 30.00, BFL 24.69, nominal f/1.2.
The image plane is 24.69 beyond the rear vertex. The strongly curved front
surface gives a broad cone and visible spherical/chromatic aberration. The
source product has a SWIR coating, but its specified EFL is at 587.6nm; this
visualization uses the glass geometry at the d line and does not model that
coating. Field sweep (±4°) is an artistic display setting.

### Diverging fan — EO 45-028

Source: [Edmund Optics 25mm diameter, −50mm focal length PCV lens](https://www.edmundoptics.com/p/250mm-dia-x50-fl-uncoated-plano-concave-lens/5540/).

Published geometry: front radius −25.84, planar rear, centre thickness 3.50,
clear aperture 24.00, N-BK7, EFL −50.00, BFL −52.31.
The bench screen is placed **35mm after the rear vertex**, a chosen display
distance rather than the negative BFL. The real rays diverge: no positive image
plane or central focal glow is claimed. Screen ticks and arrival rings mark
actual ray intersections. A fixed 30mm view semi-height contains the expanding
fan without zooming with the music. Field sweep: ±4°.

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
it is not labelled a focus. Field sweep is limited to ±1° to reduce vignetting.

### Glass constants

[SCHOTT N-BK7 glass data](https://www.schott.com/en-gb/products/optical-glass/-/media/Project/OnEx/Products/optical-glass/Downloads/schott-optical-glass-collection-datasheets-english-may2019.pdf?rev=5358bb64e13a44f2b37f5065490509af)
gives n_d = 1.51680 and V_d = 64.17; all three added designs use these values.

## Integration and validation

The three additions follow the original achromat, Cooke, and Double Gauss in
the 16-bar rotation. The title block shows the current design number. Existing
prescriptions retain their original data; this research did not revalidate
their historical attribution.

All six designs stay within the existing 45-ray / 12-point buffers. Numerical
checks covered three viewport sizes, low/mid/high extremes, and both field
limits: 648 render scenarios with finite coordinates. All six designs deliver
15/15 reference rays on axis at the quiet aperture setting. Additional checks
confirmed divergent output for the negative lens, axis crossing and nearly
parallel paraxial output for the Keplerian pair, and no focal-gradient rendering
for screen designs. The checks stubbed audio scheduling and canvas rasterization;
they do not establish live frame rate or optical manufacturing accuracy.
