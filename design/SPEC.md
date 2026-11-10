# Ortho CAD App Spec

A personal, browser-based CAD app for making 3D-printable parts by drawing in orthographic drafting views. Every view sits on one sheet and is generated from a single shared model, so they never fall out of sync.

## Goals

- Model in the flat top, front and side views used in traditional drafting, not in a free-orbit 3D viewport.
- Keep all views linked: one change shows up everywhere straight away.
- Export STL files for 3D printing.
- Keep the scope small, aimed at simple printable parts, gears included.

## Tech Stack

- Web app written in TypeScript.
- Replicad (OpenCASCADE compiled to WebAssembly) for solid modeling, fillets, hidden-line projection and STL export.
- Plain 2D canvas or SVG for the drafting views.
- Three.js for a small 3D preview.
- Optionally served from a Raspberry Pi on the home network. All geometry work runs in the browser, and the Pi just serves files and stores projects.

## Look and Feel

- Bare bones: white sheet with black lines, like a drafting table.
- A few accent colours only where they mean something, such as selection highlight, alignment guides, and shapes that currently do nothing (faded).

## The Sheet and Views

- Up to six views: top, front, bottom, left, right, back.
- The app opens with just the top view.
- Ghosted dashed boxes with a plus sign fill every open slot next to an existing view. Clicking one adds that view.
- Each ghost box is fixed to its proper drafting position and labelled with the view it will create. Front goes below top, left and right sit either side of front, bottom goes below front, and back goes to the far right.
- Views stay projection-aligned: front and top share the horizontal axis, and front and the sides share height.
- Faint guide lines extend across views while drawing so new geometry snaps to existing edges, like using a T-square.
- Back and bottom views are mirrored, which the app handles automatically.
- Unused views can be hidden.

## Tools

- Every shape has a properties panel showing its size, position, face, depth, add or cut, corner radius, and any tool-specific settings.
- Select tool: click, select, and drag handles.
- Rectangle.
- Rounded rectangle, with corner radius set as a property.
- Circle.
- Polygon, with the number of sides chosen in properties.
- Hidden-line tool: draws a dashed shape meaning it starts on the far face, seen through the current face.
- Line / polyline tool: draw any custom profile, such as an L-bracket.
- Dimension tool: drafting-style measurements; edit the number and the shape resizes.
- Pattern tool: repeat a shape in a row or around a circle (bolt-hole circles, vents).
- Mirror: draw half of a symmetrical part and mirror it across a line.
- Text tool: emboss or cut lettering, such as labels or a logo.
- Shell (later): hollow a part to a set wall thickness.
- Gear tool: sketch a rough circle, then a small dialog pops up next to it. Enter the diameter and number of teeth, and pick the gear type (spur, helical, internal ring, rack) and pressure angle (20° default, 14.5° legacy, 25° heavy duty) from dropdowns. It generates a proper involute outline. When adding a second gear, the dialog offers to match the first gear's module so they mesh, and you only enter the tooth count.

## Core Modeling Workflow

1. Draw a shape on the face of the current view. It starts at zero depth, as a sketch waiting for a depth.
2. In properties, choose positive extrude (add material) or negative extrude (cut), and set a depth or "through all".
3. Selecting a shape in any view highlights it in every view, since it is one object.
4. In a neighbouring view, a zero-depth shape appears as a line on the face it was drawn on. Drag it to give it depth.
5. Every shape has two grabbable ends, start and finish. Either one can be dragged, for example pulling the near end below the surface so the shape sits inside the part.
6. Default face: when drawing in a view, the shape goes on the nearest surface under it. You can change this in properties.

## Solid vs Hidden Lines

- Solid or dashed is never set by hand. It is worked out from geometry: if material sits in front of an edge in a given view, it is drawn dashed there.
- Pulling a shape's near end inside the part automatically turns it dashed in that view.
- The hidden-line tool is just a shortcut for starting a shape on the far face.
- Solid shapes buried in solid material have no effect and are shown faded.
- Default for hidden shapes is a pocket from the far face. Fully enclosed voids come later.

## Corners and Edges

- Sketch corners: corner radius is a property on rectangles and polygons.
- Edge fillets and chamfers: click an edge line in any view and set a radius or chamfer size (handled by OpenCASCADE).

## Data Model

- The project is an ordered list of features. Each feature stores shape type and size, which face or plane it starts on, start and end depth, add or cut, and corner radius.
- All views and the 3D preview are redrawn from this list, so they can never disagree.

## Additional Requirements

- Units: millimetres by default with an inch toggle. Set the display precision.
- Projection standard: third-angle (US) layout, as described above. Not first-angle.
- Starting point: every new project begins with a stock cube that can be resized. Only the top view is shown at first; the other views are added by clicking the ghosted plus boxes.
- Print orientation: on export, auto-pick how the part sits on the bed, such as the largest flat face down with minimal overhangs. Show a preview and allow override.
- Basics: undo and redo, delete and edit any shape after creation, zoom and pan the sheet, grid snapping with a set increment.
- Save format: the feature list saved as a JSON project file.
- Test parts: Claude Code should be able to build and verify a cube with a centred pocket, a cube with a through hole and filleted edges, and a 20-tooth spur gear meshing with a 10-tooth gear.

## Build Order

1. Sheet with the top view, adding views through ghost boxes, and alignment.
2. Rectangle and circle, add and cut, depth dragging, selection highlighted across views.
3. Automatic hidden-line rendering and STL export.
4. Rounded rectangles, polygons and the hidden-line tool.
5. Gear tool.
6. Edge fillets and chamfers.
7. Save and load projects, optionally on the Pi.
