# SnorbCAD roadmap (agreed 2026-11-10)

What the owner asked for, how each piece works, and the order we build it.
Rule for every round: **keep the layout calm.** New things go into tool
groups, the properties panel or the menus they belong to, never as more loose
buttons.

## Round 1: holes, fit, slots, arcs, tidy toolbox (building now)

1. **Hole tool** (like the gear tool). Click or drag where the hole goes; a box
   opens. Pick the screw (M2, M2.5, M3, M4, M5, M6, #4, #6, #8, 1/4", or a
   custom Ø) and the kind:
   - *Clearance* (close / normal / loose)
   - *Tapped* (the screw cuts its own thread in the plastic)
   - *Heat-set insert* (insert-sized hole, insert-deep)
   - *Counterbore* (socket-head screw sits flush)
   - *Countersink* (flat-head screw, 90°)
   - *Nut trap* (hex pocket on the far side for a nut)
   Depth: through, or a set depth. The hole stays editable (select it, Edit
   hole…). It is a real hole feature, not a circle, so later it can export
   to CAM as a drill.
2. **Printer fit.** Holes print small. One setting, *Holes print this much
   small* (default 0.2 mm on the diameter), lives in the **Sheet** section of
   the properties panel (next to units and grid snap). It's remembered as the
   default for new parts. Holes and slots grow by it when the part is built.
   The sizes you type stay the real sizes. Any cut circle or slot can opt in
   or out ("Add printer fit"). Per-hole override in the hole box.
3. **Slot tool.** Drag it out like a rectangle: length one way, width the
   other, ends fully round. Properties: length, width, angle. (Arc slots
   round a centre come with Rotate in round 2.)
4. **Arcs in outlines.** With the Line tool's outline selected, every side has
   a small handle in its middle: drag it to bow that side into an arc (drag it
   back to straight). Properties show each arc's radius.
5. **Tool groups.** Shapes (rectangle, slot, circle, polygon) share one
   toolbox button with a flyout, like Illustrator: hold the button (or click
   its little corner triangle) to pick another. The button shows the last one
   used. Hole, Gear and Text are the "make" tools.

## Round 2: move things around

**Shipped 2026-11-11:** corner-drag rotate (1° steps, Shift 15°, Option free), rotate tool ⇧R with angle, 3×3 pivot or typed point, live preview and Copy; ⌘C/⌘X/⌘V/⌘D through a clipboard shared by two part tabs (+ Part); measure tool M (snaps to corners and centres, Shift level/plumb). A rectangle turned to an odd angle becomes an outline.

- **Rotate.** Hover just outside a selected shape's corner: the cursor turns
  into curved arrows; drag to turn it round its centre (Shift = 15° steps).
  Plus a **Rotate tool** that selects like the select tool and opens a box:
  angle, and the pivot (centre, a corner, the part's origin, or a point you
  click).
- **Copy / paste / duplicate** (⌘C ⌘V ⌘D) inside a part and **between parts**.
  **Two parts open** at once, as tabs over the sheet.
- **Measure tool**: click two things, read the distance (and angle).

## Round 3: enclosures and the library

**Shipped 2026-11-11** (9c1b2fd, 12af413): Body › *Hollow* (walls, open face) and *Make a lid* (opens in the other part tab); named sizes and formulas in any size box (blue = remembers its formula); *Library…* with three shelves: My parts (3D thumbnails, saved with each part), the printer's Models, and Footprints (Pi 4/5 and Pico holes or standoffs, SG90, MG996R, 608 seat, 5/10 mm LED, EC11, M3 insert boss: dropped on the top face, or the floor of a hollow box); *Export ▾* (STL, or a DXF of any view, hidden lines optionally on their own dashed layer). Not done yet: Pi port cut-outs and the 5 V buck board footprint.

- **Shell / hollow**: not a tool; it's in the **Body** properties (what the
  panel shows when nothing is selected): *Hollow: wall 2 mm, open face: top*.
  A **Make a lid** button makes the matching lid as a new part, with a lip and
  the printer fit as clearance.
- **Library** in SnorbCAD like the printer's (3D thumbnails), two shelves:
  - *My parts*: everything saved (these already go to the printer).
  - *Footprints*: ready-made cuts and bosses to drop on a part: Pi 5 / Pi 4 /
    Pico mounting holes and port cut-outs, SG90 / MG996R servo pockets, 608
    bearing seat, 5 V buck board, rotary encoder, 5 mm / 10 mm LED holes.
    They are groups of normal features (holes, pockets, standoffs), so they
    print as part of whatever you drop them on.
- **Named sizes**: `wall = 2`, `m3 = 3.4`; type a name or a sum (`wall*2+1`)
  in any size box.

## Round 4: SnorbCAM (for the ShopBot, replacing the trip to Easel)

**v1 shipped 2026-11-11** (code in `design/src/cam/`, built to `web/design/cam.js`):
- A SnorbCAM tab: a 96"×48" sheet (any size and thickness), zero at the
  lower-left and on top of the material.
- Add parts from an **SVG** (Illustrator 1/72" or 96 dpi), a **DXF** (lines,
  arcs, polylines with bulges, circles, ellipses, splines; loose pieces get
  joined), or a **SnorbCAD part** (also via *Send to SnorbCAM* in SnorbCAD):
  the body cuts out, top cuts keep their depths, counterbores become a head
  pocket over the bore, and stepped cuts start at their own Z.
- Per outline: Off / On / Inside / Outside / Pocket (rings, or rows ↔ ↕,
  islands left standing), depth, where it starts (Z), bit, **first pass,
  equal middle passes, finishing pass**, ramp-in angle, climb or
  conventional, tabs (count, width, thickness; drag them along the outline,
  double-click to add or remove).
- Parts: drag, arrow-key nudge, R turns 90°, ⌘D duplicates (copies cut the
  same), undo. Bit library with Ø, feed, plunge, depth per pass, stepover.
- Order: each cut to depth, or Easel-style layers; inside cuts before cut-outs.
- Toolpaths drawn at the bit's width; time estimate; **Export G-code**
  in the exact format of the Easel files the ShopBot already runs (G20, G0/G1
  only, plunge feed for anything going down); one file per bit.
- Jobs save on the Pi (`~/printer_data/cam`, `/studio-api/cam`).

Next for SnorbCAM: V-carve and engraving text, drilling (peck) for holes, a
3D cut preview / step-through, nesting (pack parts on the sheet), Z zero at
the spoilboard as an option, leads in/out.

## Round 5: checks and new shapes

**Shipped 2026-11-11:**
- *Check* (75abb25): thin walls under 2 nozzles, gaps under 1, overhangs past 45° (flat bridges under 10 mm pass), round holes on their side (*Make it a teardrop*, also a checkbox on the hole), tiny posts and text under 3 mm. *Show* lights the spot up red and turns the 3D view to it. Runs before Send to Prepare / Library with *Print anyway* (not asked again for the same part). Checked as drawn, bottom face on the bed.
- *Revolve* (96dc761): any outline's panel › *Revolve: spin it round a side*; centre line on any side, line position, angle (360 = all the way). A sphere today = a half circle (line tool, bow a side) revolved.
- *Section* tool (4dc02e7, in the Dimension/Measure flyout, key X): drag a level or plumb cutting line on a view; the view it looks into becomes SECTION A–A with the cut faces hatched; Body panel › Sections to move, flip or remove.
- *Fit test* (2152ae9): Sheet › Printer fit › *Fit test…*: opens an M3 plate (holes 3.0 to 3.4, labelled 0 to .4); print it, then click the hole the screw slid through snugly to set the fit for this and new parts.

- **Printability check**: a *Check* button, and an automatic check on Send to
  Prepare / Send to Library. It flags walls thinner than 2 nozzles, overhangs
  past 45°, holes sideways to the bed (offers a teardrop), tiny features. It
  warns; **Print anyway** always works.
- **Revolve**: draw half a profile against a centre line, spin it (knobs,
  spacers, pulleys, button caps).
- **Section view** (drafting style): draw a cutting line across a view and get
  a "Section A–A" view with the cut faces hatched.

## Later (planned for, not built)

### Angled faces (work on a chamfer or any sloped face): the plan
Every feature already lives on a sketch plane: its view's face (u, v) plus
depths along the view's eye. So:
1. **Data:** a feature may carry its own `plane {origin, x, normal}`; when it
   does, (u, v, d) map through that plane instead of `VIEWS[view]`. The six
   views stay as six ready-made planes. `featureSolid` already builds
   `new Plane(origin, uDir, eye)`, so geometry is a small change.
2. **Pick the face:** with a new *Work on a face* tool, click a flat face in
   the 3D preview (or in a view where it shows as a sloped line). SnorbCAD
   opens an **auxiliary view** that looks square-on at it (the drafting way:
   placed beside the view where the face is an edge, projected at right
   angles to that edge), and every tool draws there as usual.
3. **Sheet:** an auxiliary view gets its own slot after the six; its edges
   come from `projectView` with a camera along the face's normal (the
   projection code already takes any direction).
4. **Elsewhere:** dims and snapping work in the aux view's (u, v); copy,
   rotate about its normal; SnorbCAM import skips features not on the top.
   The printability check needs nothing (it reads the built part).

### Start from a shape (shipped 06bccbf)

Body › *Start from a shape*: Block, Cylinder or None. The shape is the
first entry in Features (click it for size, Hollow, Delete; ⌫ deletes,
undo restores). Data is still `p.stock` plus `stock.shape`. Sphere and
cone go in the same list later.

Known slow spot: a hollow cylinder with a hole through its wall takes
about 8 s per side view to work out hidden lines (exact HLR on the curves
where the hole meets both round walls; a solid cylinder with the same hole
takes 0.26 s). The faster approximate HLR (HLRBRep_PolyAlgo) is in the
OpenCascade build, but its shape output (PolyHLRToShape) isn't bound.

### New part dialog, SVG import, line tool, sketches in 3D (shipped 7e73d97)

- New / + Part: units + drawing area (`p.area` {w,d,h} mm; presets in
  AREA_PRESETS), framed on every view, editable under Sheet.
- File ▾ › Import SVG… (or drop on the sheet): svgdialog.ts samples paths
  in the browser, svgimport.ts does units, nesting (holes), simplify,
  placement. Text needs converting to paths first.
- Line tool: Shift = level/plumb/45° (`squareTo`), ruler with length + angle.
- Sketches (zero depth) drawn flat in the 3D preview (`sketchLoops`).

### Spheres
Possible now with Revolve (a half circle against its centre line). Next: a
*Sphere* shape in the shapes flyout (click the centre, drag the radius in any
view; add for a ball or knob, cut for a ball socket or dimple), built as a
real sphere so it stays smooth, with a *Dome* option (half a sphere on a face).
