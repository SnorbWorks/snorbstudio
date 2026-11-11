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

- **Rotate.** Hover just outside a selected shape's corner: the cursor turns
  into curved arrows; drag to turn it round its centre (Shift = 15° steps).
  Plus a **Rotate tool** that selects like the select tool and opens a box:
  angle, and the pivot (centre, a corner, the part's origin, or a point you
  click).
- **Copy / paste / duplicate** (⌘C ⌘V ⌘D) inside a part and **between parts**.
  **Two parts open** at once, as tabs over the sheet.
- **Measure tool**: click two things, read the distance (and angle).

## Round 3: enclosures and the library

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
- **DXF export** of any SnorbCAD view (round 3), for the laser.

## Round 5: checks and new shapes

- **Printability check**: a *Check* button, and an automatic check on Send to
  Prepare / Send to Library. It flags walls thinner than 2 nozzles, overhangs
  past 45°, holes sideways to the bed (offers a teardrop), tiny features. It
  warns; **Print anyway** always works.
- **Revolve**: draw half a profile against a centre line, spin it (knobs,
  spacers, pulleys, button caps).
- **Section view** (drafting style): draw a cutting line across a view and get
  a "Section A–A" view with the cut faces hatched.

## Later (planned for, not built)

- **Angled faces** (work on a 45° chamfer) and **spheres**.
  *Don't paint into a corner:* every feature already lives on a sketch plane
  (its view's face plus depths). New features keep that shape, so later a
  feature can carry its own plane (origin + normal + direction) and the six
  views become six presets of it. Spheres become a body primitive or a revolve
  of a half circle.
