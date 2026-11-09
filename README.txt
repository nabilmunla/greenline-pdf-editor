PDF EDITOR - version 0.9.2
==========================

INSTALL IT
  Run "PDF Editor Setup 0.9.2.exe" (one file). Install puts it in your own Programs
  folder - no admin rights - with a Start menu shortcut, a desktop shortcut and PDF
  Editor listed in "Open with" for PDFs. Options: install for everyone on the PC
  (asks for admin rights; Program Files), another folder, no desktop shortcut, not
  in "Open with", and the updates folder.
  Run from the company's updates folder, the setup remembers that folder by itself
  (as \\server\share, not a drive letter). Your settings and keys survive reinstalls.
  Remove: Windows Settings > Apps > PDF Editor > Uninstall (or "PDF Editor Setup.exe"
  in the app folder). Optionally removes your settings too; your PDFs are never touched.
  For IT: "PDF Editor Setup 0.9.2.exe" --silent [--all-users] [--dir "D:\Apps\PDF Editor"]
  [--no-desktop] [--no-open-with] [--updates "\\server\share\PDF Editor"];
  uninstall: "<app folder>\PDF Editor Setup.exe" --uninstall --silent. Log:
  %TEMP%\PDF Editor Setup.log.
  Windows may warn on first run ("Windows protected your PC" > More info > Run anyway)
  because the setup isn't signed with a company code-signing certificate.
  If the setup window stays empty, it switches to plain Windows prompts by itself after
  a few seconds; "PDF Editor Setup 0.9.2.exe" --plain uses the plain prompts straight away.

UPDATES
  An installed copy looks in its updates folder for a newer version at start and every
  4 hours. When there is one, a card (bottom right) asks: Update / Later ("What's new"
  on the card shows the changes in short). Nothing is downloaded before you say so. From 0.8.2 on
  an update is only offered when its latest.json carries the publisher's signature (anything
  else in the folder is refused); the download is checked (SHA-256) against that signed list
  before it is used; then "Restart now" or "When I close it" - you're asked to save changes
  first, the update takes a few seconds, PDF Editor reopens.
  Away from the company network (home, server off, VPN down) nothing happens: no
  errors, no waiting - the check runs in the background with a time limit.
  Settings > Updates: the folder (change it, or empty = no updates), Check now, and
  "Go back to <previous version>" if a new version gives you trouble.
  Copies that weren't installed with the setup (portable folders) don't update.
  From the web: the "updates folder" can also be a web address - the public download page
  on GitHub, which copies installed from there use by themselves when no folder is set. The
  same signature and checksum checks apply; a version that needs its setup opens the
  download page instead of a folder.
  A version that brings a new built-in browser (Electron) can only be installed by its setup:
  the card then says so and shows the setup in the updates folder - close PDF Editor and run
  it (files and settings stay). PDF Editor never starts a downloaded setup by itself: company
  antivirus treats that as malicious behaviour (0.8.2's update was stopped that way).

WHAT'S NEW
  File > What's new (or Settings > Help): this version's changes in a few lines - new
  features, polishing, fixes - and earlier versions folded away below.

REPORTING PROBLEMS
  File > Report a problem (or Find a tool: "report"): say what went wrong; a picture of the
  window as it was can go with it. Crashes are reported by themselves (once per kind a day).
  Reports go to the "reports" folder inside the updates folder - one file each, with the
  version, Windows version, your Windows user name and the app's recent log (can contain
  file names), never the PDFs. Away from the network they wait on the PC and go later;
  Settings > Help shows how many are waiting. The share needs one permission for this:
  users may create files in <updates folder>\reports.
  The public download (GitHub) sends reports anonymously instead, to the developer's own server:
  Report a problem sends your words (and the picture, if kept); crash reports only once you turn
  them on in Settings > Help. Taken out before sending: your user name, PC name, file names,
  folders and paths; the time is rounded to the hour; never the PDF files (the picture, if
  kept, shows what is on screen). Settings > Help shows an example of exactly what goes. The
  receiver runs on Cloudflare (which sees the internet address; the receiver doesn't keep it);
  reports are kept 6 months.

PUBLISHING A NEW VERSION (for whoever looks after the share)
  Each version comes as a folder "publish-v<version>": latest.json, app-v<version>.zip,
  PDF Editor Setup <version>.exe, source-v<version>.zip. Copy them all into the updates
  folder on the share - latest.json LAST (apps see the new version once it's there).
  The apps only read that folder (except "reports", see above). Keep it writable only by
  whoever publishes. latest.json is signed when the version is built (copies from 0.8.2 on
  refuse an unsigned or changed one); copies older than 0.8.2 still install whatever it
  names until they have updated once.

START IT
  Start menu > PDF Editor (installed), or PDF Editor\PDF Editor.exe (portable copy).

  Make it open your PDFs: Settings (gear, top right) > "Add to Windows Open with".
  PDF files then show a PDF page icon (white page, red PDF label, small G) in
  Explorer - give Explorer a moment, or sign out/in, if old icons stay cached.
  Then right-click any PDF > Open with > Choose another app > PDF Editor > tick
  "Always use this app". Windows only lets you make that choice yourself.
  From then on a double-clicked PDF opens as a new TAB in the running window.

EVERYTHING STAYS ON THIS PC
  No internet, no cloud, no account. OCR (English + Arabic) runs offline.
  The only exception is the AI assistant (AI tab), and only when you use it: see below.

HOW IT IS ORGANISED
  Ribbon tabs at the top: File, Home, Comment, Measure, Edit, Organize, Protect,
  OCR, AI, Batch. Every open PDF is a tab under the ribbon. Left: Pages, Bookmarks,
  Comments list, Search. Right: properties of what you selected (or of the tool).
  Status bar: page, zoom, the page's scale, Snap on/off.

FIND A TOOL  (box in the title bar, or Alt+Q)
  Forgot which tab something is on? Type what you want to do - "page numbers",
  "compress", "measure area", "password", "redact", "rotate". The list shows each
  matching tool and where it lives (e.g. Edit > Page marks); typos are fine. Enter
  (or a click) switches to that tab, points the button out and runs it. With the box
  empty it shows the tools you found last.

PRINTING  (Ctrl+P, or Print on the Home tab / File)
  One panel with a preview of each sheet exactly as it will print:
  - Printer and copies (collate). "Printer preferences..." opens the settings of the
    printer picked in the panel (tray, quality, stapling) in their own window; what you
    keep there applies when you print. Paper, copies, sides and colour are set in the panel.
    The paper picked (A3, A4...) is the paper the printer uses.
  - Pages: all, this page, what's in view (the part of the page on screen, enlarged to
    the paper - handy for a detail of an A0 sheet), the pages selected in the Pages
    panel, or a list (1-5, 8, 11-). Odd / even only, reverse order.
  - Document and markups, or document only (form fields always print).
  - Paper (A4...A0, Letter, Legal, Tabloid, or the page's own size), orientation
    (Auto turns the paper to suit each page), size: Fit (inside a margin you set),
    Actual size (100 %, for drawings to scale), Shrink large pages only, or a %.
    The line under the preview says e.g. "A0 page on A3 landscape at 34 %".
  - Colour or black & white, one- or two-sided.
  - Save as PDF...: the same sheets as a file instead of printing.
  - Send as: Auto (default) sends sheets as they are, except those heavy for a printer -
    big scans, dense drawings, colour scans printed in black & white - which go as one
    300 dpi picture each (grey in black & white): a far smaller job for Windows and the
    printer. "As they are": everything exactly as it is (sharpest; heavy files can take
    long to print). "Pictures": every sheet as a picture. A0-A1 sheets (plotters) stay
    as they are in Auto. While pictures are made the panel shows progress (Cancel
    stops it), and the seconds the printer takes. The panel remembers your settings.

MOVING AROUND
  A file reopens where you left it: same page, same spot, same zoom - and each tab keeps
  its own place when you switch between tabs.
  Zoomed in, the Pages panel shows a box on the page's thumbnail where you are; drag the
  box to move around the sheet (when it covers most of the thumbnail, dragging moves the
  page instead, as usual).
  Mouse wheel scrolls, Ctrl+wheel zooms at the pointer (Settings: the wheel can zoom
  instead). Hold Space (or the middle button) and drag to pan with any tool.
  Ctrl+0 fit page, Ctrl+2 fit width, Ctrl+1 actual size, Home/End first/last page.
  Heavy A0 drawings appear tile by tile and stay sharp at any zoom. A drawing you
  opened before shows up at once (its pictures are cached on this PC).

MARKUPS  (Comment tab)
  Highlight / underline / strikeout / squiggly: drag over text. Drag on an empty
  spot with Highlight = area highlight.
  To change one afterwards: click it, then drag the round handle at either end along
  the text - it covers more or less, snapping to whole characters, onto other lines
  too (Ctrl+Z undoes it). Its comment follows the text unless you wrote your own.
  An area highlight is a box: move it or drag its corners.
  Comment (sticky note), Text box, Typewriter (text without a box),
  Callout = text with a pointer: click the point, then click where the text goes.
  Rectangle, Ellipse, Line, Arrow, Polyline, Polygon, Cloud, Pencil.
  Stamp (ready-made + your own designs + pictures such as a company seal),
  Signature (draw, type or a scan; kept on this PC only), Image.
  Your own stamp from a scan or a phone photo: Stamp > From a scan or photo (a picture
  or a scanned PDF), Paste a picture, or From a page (drag a box round a stamp on
  an open scanned page). The paper is taken away (also uneven light and yellowed
  paper), black text and lines running through it are left out, dust removed, the
  stamp cropped, straightened and given its real size. Change the crop, the colour
  (its ink, as scanned, or blue/red/green/purple/black), the clean-up and the turn,
  then Save. "Pick the ink" when a different colour was taken for it.
  Copy to pages (Comment > Manage, or right-click a markup): the selected stamp or
  markups onto all pages or some - the same distance from the nearest corner, so a
  stamp in the title block lands in the title block of an A1 and an A3 alike. One
  Ctrl+Z takes back all the copies.
  Stamps, signatures and pictures keep their shape when a corner is dragged (hold
  Shift to stretch a picture stamp or signature; text stamps always keep it).
  Colours, fill, line width, dashed, cloud edge, arrow ends, opacity, text size:
  Style group on the ribbon: for the tool when nothing is selected, for the selected
  markups when they are (as the right panel). Ctrl+Z takes a change back.
  Tool Chest: save a styled tool and reuse it with one click.
  Keep tool: stay in a tool after placing a markup.

  Select a markup: drag it to move, drag the squares to resize, drag the round handle
  to rotate (Shift = 15 degree steps; or type the angle; or 90 degree buttons).
  Lines/polylines/polygons: drag their points.
  Text boxes, callouts and typewriter text: CLICK and the box starts small and fits the text
  as you type - wider with each word, wrapping onto new lines past about 13 cm (or at the page
  edge), shorter again when you delete. DRAG a box instead to give it a fixed width (the text
  wraps inside it and it grows downwards). Resizing a box by hand fixes its width; tick "Box
  fits the text" in the right panel to make it fit again.
  Text boxes and callouts: typing starts as soon as you draw one. A small bar above
  the box sets font, size, colour and alignment while you type; you can click and
  drag-select inside the text.
  FORMATTING LIKE A WORD PROCESSOR: select a word or a few, then press B / I / U on the
  bar (or Ctrl+B / Ctrl+I / Ctrl+U), or pick a colour, size or font - only the selected
  text changes. With nothing selected the whole box changes. Ctrl+Z / Ctrl+Y while
  typing undo / redo typing and formatting. The formatting is saved the standard way:
  other PDF programs show it and keep it. Grab the box's frame to move or resize it at any time
  (before or after typing). Click elsewhere, Done or Esc to finish. Double-click (or
  Enter / F2 on a selected box) to type in it again. A callout's arrow stays on the
  point it shows when you move the box; drag the arrow's tip to point somewhere else.
  The box grows downwards when the text needs more room.
  FONTS: Helvetica, Times and Courier are built into every PDF program. "From this PC"
  lists the typefaces found in Windows (Arial, Calibri, Segoe UI, Tahoma, Verdana,
  Georgia, Times New Roman, Consolas, ...): the letters used are put into the file, so
  everyone sees the same font. B / I = bold / italic. The tool's own font (for new boxes)
  is set in the right panel while the tool is picked.
  ARABIC works in text boxes, callouts and typewriter text: letters joined, right to left,
  mixed with English and numbers, starting on the right. If the chosen font has no Arabic
  letters (e.g. Calibri), they come from Arial / Tahoma / Segoe UI.
  Ctrl+C / Ctrl+X / Ctrl+V copy, cut and paste markups (also into another open file);
  Ctrl+D duplicates; right-click on the page > Paste markups here puts them there.
  Arrow keys nudge (Shift = 10x). Delete removes. Ctrl+Z / Ctrl+Y undo / redo
  (everything: markups, pages, redaction, text edits) until the file is closed.
  Lock (right panel or right-click): a locked markup can't be moved, changed or
  deleted - it uses the standard PDF "Locked" flag, so other PDF programs respect it too.
  Flatten: burns markups into the page - selected ones, by kind, or everything.
  Until flattened, everything can be moved and deleted.
  Comments list (left): group by page / kind / type / author / colour / status,
  filter, click to jump there, replies and status in the right panel. Excel or PDF
  (buttons at the bottom): the list as shown - the PDF has a picture of each markup
  with its comment, replies, author, date and status (a clarification log to send round).
  Markups are standard PDF annotations: any PDF program shows them.
  Text boxes made in other PDF programs keep their own
  look when turned, moved or pasted. Change their text or style, or resize them, and
  they are drawn by PDF Editor from then on - same size, colour and bold, in the closest
  built-in font (Helvetica / Times / Courier); words they had in bold, italic, another
  colour or size stay that way.
  The right panel stays open (F4 or Home > Settings panel hides / shows it), so the
  page doesn't jump sideways when you select something.
  Small screen or Windows scaling at 125-175 %: the ribbon squeezes itself (smaller
  buttons in rows, then icons only - hover an icon for its name) instead of hiding
  buttons off the right edge. Closing the right panel (F4) gives the ribbon room back.

MEASURE  (Measure tab)
  Set the scale first: Scale (1:50, 1:100, 1/4"=1'... or the scale found printed on
  the sheet) or Calibrate (click both ends of a known dimension, type its length). The
  Calibrate window can be dragged by its title to see the line under it.
  For this page, chosen pages or all pages. Viewport = a part of the sheet drawn at
  another scale. The scale is saved inside the PDF.
  Separate X and Y scales (a long section with exaggerated heights, a sheet printed
  stretched): Scale > Direction > Across (X), pick it, then Up-down (Y); or Calibrate with
  Direction X on a horizontal dimension, then Y on a vertical one; a viewport can have its
  own up-down scale. The status bar then shows "X 1:100 · Y 1:20". Lengths, areas and
  angles use both.
  Length, Polylength, Area, Angle, Count (name what you count, e.g. "Doors D1").
  Area gives the perimeter too: "27.88 m² · P 21.200 m" (Totals and To Excel list the
  perimeters apart). Perimeter measurements from older versions still show and count.
  Area draws as (strip at the foot of the page, or the keys while the tool
  is on): Corners (P) - click each corner; Rectangle (R) - drag from one corner to the
  opposite one or click the two (Shift = a square); Circle (O) - click the middle, then a
  point on the edge. A circle is measured as the circle (pi r², 2 pi r - an ellipse with
  separate X / Y scales). Selected: a rectangle keeps its square corners when you drag a
  corner (hold Alt to move that corner alone); a circle has one handle for its size.
  While drawing by points (Polylength, Area by corners, Polyline, Polygon, Cloud):
  Ctrl+Z (or Backspace / Delete) takes back the last point, again and again; Ctrl+Y
  puts it back. Esc cancels the shape - Ctrl+Z straight after brings it back. Shift+C
  closes it (a line goes back to its first point). Enter, double-click or right-click
  finishes. A bar at the foot of the page shows the length / area so far, with the same
  as buttons. The tip shows each segment's length and direction.
  Changing a shape afterwards (select it): drag a corner - it snaps to line work, other
  markups and the shape's own other corners (Shift: the edge straight). Drag the small
  dot in the middle of an edge to add a corner there; Alt+click a corner to delete it.
  Right-click: Add a corner here / Delete this corner / Continue this line (a polylength
  or polyline drawn on from its nearer end). Count: Backspace takes back the last mark.
  Typed lengths: after the first point of a Length, Polylength or Area by
  corners, type the length - 4200 (millimetres: a whole number of 100 or more), 4.2 or
  4,2 (metres), 4200mm, 420cm - the tip shows how it is read; Enter puts the next point
  that far from the last one, towards the mouse. Backspace / Escape correct it.
  Totals (Measure > Results, or the panel on the left): every count name with how many
  (per page too - click to go there with them selected; + Count to count more of it)
  and the measurements added up by kind and page.
  Count by tag (Measure > Count > By tag…): type the tag written on the drawing (D, FD-,
  W1), starting with / exactly / containing, this page or all pages; the ones found are
  listed by tag - untick any - and counted in one go (one name for each tag, or one name
  for all; places counted already are left out; one Undo). Scans: OCR them first.
  Values show on the sheet; To Excel exports them all with
  count totals: the number in Value (a real number, as many decimals as on the sheet),
  its unit (m, mm, m², °, ft...) in Unit, an area's perimeter in its own two columns,
  and the label as written on the drawing beside them. A label you typed yourself ("Kitchen") gets the measured number in Value.
  Numbers: metres with 3 decimals, millimetres (under 1 m) with none, m2 with 2.
  Change it before measuring (right panel, or Decimals (m) on the ribbon) or after
  (select the measurements > right panel: unit and decimals). A label you typed
  yourself is left alone.
  Number size: new numbers are sized for the zoom you measure at (zoomed in on a detail
  = small on the sheet, normal on screen); a length's line and arrows too. The arrows
  are always about as long as the number is tall. Labels > Number size changes all of
  them in the file at once (one Undo) - also older ones, which get the new arrows;
  one measurement: right panel > Number size.
  These are one-off measurements - project take-offs belong in your estimating tool.

SNAPPING  (F9 or the status bar)
  Lines, shapes, clouds and measurements snap to drawing line ends, middles,
  points on lines and the corners of other markups. A coloured square shows where it
  will snap and a label says what. Hold Ctrl while clicking to skip snapping once;
  hold Shift for 0/45/90 degree lines.

EDIT  (Edit tab)
  Edit text: click a line of text, change it, Enter. (One line at a time.) Arabic works
  too: an Arabic line keeps the old line's right end, and stays searchable.
  Redact: Mark area / Mark text / Find & mark (names, numbers...), check the red
  marks, then Apply: the content under them is REALLY removed from the file - text,
  the covered parts of pictures and line work - not just covered with black.
  The box left behind: Black, White, Match page (takes the colour of the page around
  it, so it blends into a coloured background), None, or any colour - in the right
  panel for the tool (before marking) or for selected marks.
  Numbers & headers: page numbers, headers/footers, Bates numbers, watermark, a
  stamp on every page (fields {page} {pages} {date} {file} {bates}).

TABS, WINDOWS AND CLOSING
  Right-click a tab: Close, Close others, Close tabs to the right, Close all, Move to a
  new window, Show in folder, Copy file path. Middle-click a tab closes it.
  Many files open: the tabs get narrower to fit; past that the row scrolls (mouse wheel
  over the tabs) and the button at the right end of the row lists every open file - pick
  one to show it. The number on it says how many are open when some are out of view.
  Drag a tab along the row to put it elsewhere. Drag it down out of the row and let go:
  the file opens in a window of its own (for two files side by side, on two screens).
  Drag a tab onto another PDF Editor window (its tabs or the top of it): it joins that
  window; a window whose last tab left closes. Unsaved changes go with the file (undo
  starts again in the new window). Files opened from Explorer go to the window you used last.
  The window's X with several files open asks: close all, or just this file. Several
  unsaved files: one question - save all, don't save, or ask for each. The app ends when
  its last window closes.

EXPORT TO WORD AND EXCEL
  File > Export to Word... / Export to Excel... (or Find a tool: "pdf to excel"). Whole
  file or some pages. Made for tender documents:
  - Excel: tables become real cells - numbers as numbers (thousands, decimals, brackets
    for negatives and % as printed), each item's wrapped description in one cell, merged
    cells, borders and shading, column widths, header row frozen and repeated when
    printed. A bill running over many pages becomes one sheet with its header once
    (repeated page headers, "carried forward" headings and page numbers left out); each
    bill gets its own sheet, named after it. "One per page" makes a sheet per page.
    References like 1.10 and codes like 007 stay text.
  - Word: paragraphs (not one box per line), headings, bullet and numbered lists, fonts,
    bold/italic/underline, colours, tables (joined across pages), pictures and logos,
    links, page size per page, page headers and footers with live page numbers.
  - Scanned pages are read with OCR (choose the language). Stamps and handwriting in
    coloured ink, and a rubber stamp repeated on every page (company name, "TENDER
    DOCUMENTS", a received date), are left out - untick that option to keep them.
  - Filled-in form fields are exported with their values; comments and markups are not.
  - Pages printed sideways (a landscape table in a portrait document) come out the
    right way round.
  Only a table or two off a big drawing? File > Table area to Excel: drag a box around it.
  What to expect: a typed (digital) PDF converts very closely. A scan is only as good as
  the OCR: check the numbers against the paper before relying on them - a faint
  photocopy, a stamp over the figures or handwriting will give mistakes. Drawings are
  exported to Word as pictures and skipped in Excel.

ORGANIZE
  Select pages in the Pages panel (Ctrl/Shift+click), drag them to reorder, drop
  PDF files into the panel to insert them. Right-click a page (or the selected pages):
  rotate, duplicate, extract, replace, save as pictures, delete, insert a blank page
  before/after, insert from another file, OCR, translate or ask the AI about them.
  Each file keeps its place in the Pages panel when you switch tabs.
  - Insert from file: pages of another file that is OPEN in a tab (as it is now, unsaved
    changes too - no file dialog) or of a file on disk. Type the pages like when printing
    (1-3, 5, 8-10 - in the order typed) and where they go (after / before page N, start, end).
  - Replace (revised sheets): pages of this file swapped for pages of another one, the rest
    left as it is. Bookmarks, links and page labels that pointed at the old sheet now show
    the new one; markups on the old sheet go with it. "5-8" replaced by 5 new pages puts
    the extra one after page 8; fewer new pages take the left-over old ones out.
  - Extract: type the pages (1-3, 5, 8-10); save the new file now, or open it as a tab and
    save later; tick "Remove these pages" to take them out of this file (Ctrl+Z puts them back).
  - Pictures (also File > Save as pictures): pages as PNG (sharp - drawings) or JPG
    (smaller - photos) at 96 to 600 dpi, one file, or a folder of "name - p01.png"...
    An A0 at 600 dpi would be a picture of half a billion pixels: such pages are made at
    the most the program allows (about 60 million pixels) and you are told.
  - Crop, split (every N pages / ranges / by bookmarks), merge files. Merge takes a file
    at a time and writes as it goes: a set of thousands of pages and over 1 GB works, with
    progress and Stop.
  New PDF from pictures (File > New from pictures, or drop / open JPG, PNG, TIFF files):
  photos, scans and screenshots become the pages of one PDF in the order listed - each at
  its own size, or fitted on A4 / A3 / Letter (landscape pictures on landscape pages). A
  multi-page TIFF gives all its pages; JPGs go in unchanged. It opens as a new tab; OCR it
  (one click on the message) to make it searchable.

BOOKMARKS  (left panel)
  Add makes one for the page in view (after the one chosen); type its name. Rename: F2 or
  double-click. Delete: Del (asks when it has bookmarks under it). Move: drag it (onto the
  upper or lower edge of another = before / after it, onto its middle = under it), or
  Alt+Up / Alt+Down, Alt+Right (under the one above) / Alt+Left. Right-click: point it at
  the page in view, add one under it. Each change is one Ctrl+Z and is saved in the PDF;
  colours and bold of the others are kept.

SEARCH  (Ctrl+F)
  This file, or All open files: every hit listed under its file's name (each file its own
  colour band down the left; files with nothing found are named in one line at the end;
  Fold all / Open all). A click on a hit in another file brings that tab to the front at
  the hit. Enter goes to the next hit - on into the next file. Stop ends a long search.
  From Explorer: select PDFs, right-click > "Combine with PDF Editor" (Windows 11: Show
  more options first). The Merge window opens with them in name order - reorder, Merge,
  the result opens as a new tab. (Installed copies; a portable copy gets it with
  Settings > "Add to Windows Open with".) Windows offers this entry for up to 100 files
  at a time - for more, open Merge in the app and drag the files into it.

OCR  (OCR tab)
  Make searchable: reads scanned pages (English, Arabic or both) and adds invisible
  text - the pages look the same but you can search, select and copy. Crooked and
  sideways scans are handled. Pages that already have text are left alone; "Read again
  pages made searchable before" redoes only pages this program made searchable (pages
  with typed text are never given a second, hidden copy). One run is one Undo.
  Speed: several pages are read at once (about one per processor core, up to 4).
  English only is faster than English + Arabic (that reads every page with both).
  Accuracy is not traded for speed: every page is read at 300 dpi (sheets bigger than A2
  at up to 7,000 dots along the long side - about 210 dpi on A1, 150 dpi on A0).
  Read area: drag a box, its text is copied (also on scans).
  Table to Excel: drag a box around a table - also one lost on a big drawing: rows and
  columns go to the clipboard for Excel; "Save as Excel..." reads just that area the way
  Export to Excel does (ruled columns, numbers as numbers, decimal commas, merged
  headings). Drag the next box for the next table. Works on scans and turned pages too.

AI ASSISTANT  (AI tab, or Home > Ask AI)  - optional, off until you add a key
  Ask questions about the open PDF and get answers that point to the pages they come
  from (click p.12 to go there). Translate a page, selected pages or the whole file
  (Arabic, English and more); copy it, save it as a PDF or open it as a new tab.
  Works with Claude or ChatGPT: paste an API key from your company's account
  (AI tab > AI keys). The key is stored encrypted on this PC. API use is billed per
  question to that account.
  What is sent: only when you press Send / Translate, and only the pages listed under
  the answer ("Sent: ..."). Up to 20 pages go as the pages themselves (the AI reads
  the text and sees drawings); more pages go as their text - for very long files the
  pages most related to your question - plus pictures of scanned/drawing pages.
  Answers and machine translations can be wrong: check figures and contract wording.

  OFFLINE TRANSLATION (AI tab > Translate > Engine: Offline) - no key, no cost
  The translation models run on this PC: nothing leaves it. The first time you use
  a language pair, press "Download language pack" (about 40 MB, checked against its
  checksum); after that it works without internet.
  English <-> Arabic and many other languages (other pairs go through English).
  It translates the text of the pages; scans need OCR first (OCR tab). Wording is
  more literal than Claude/ChatGPT - fine to understand a document, check before
  sending anything translated this way.

PROTECT
  Password (AES-256) with print/copy/edit limits - saved as a new copy (no commas in passwords).
  Remove password. Remove hidden info (author/title data, scripts, unused content).

BATCH  (many files at once)
  Reduce size (pictures made lighter; line work and text untouched), Merge, Split,
  Stamp & number (Bates numbers run on across the files), Make searchable (OCR),
  Flatten. New files go next to the originals with a suffix, into a folder you
  choose, or replace the originals (a backup is kept).

HUGE FILES (500 MB merged drawings and scans)
  Files are read from disk as pages are needed - never loaded whole - so a 300 MB scan
  book opens in under a second. Drawing, editing and batch jobs run in separate
  background engines: if one runs out of memory on a monster file, it restarts by
  itself and the window carries on (if it was the editing engine, the file comes back
  from the last automatic copy and undo starts again; you get a message).
  Sheets made of millions of tiny line pieces (traced or some CAD exports, 40+ MB for one
  page) are simplified when opened: runs of separate strokes become fewer, longer ones -
  the drawing looks the same, it now opens and draws, and saving keeps the lighter
  version. A page that still takes the drawing engine down twice shows "This page is too
  heavy to draw" (Try again) instead of retrying forever; markups still work there.

SAFETY
  Saving writes the new file next to the old one first (hidden, .~name.part) and then swaps
  it in - a crash or a full disk never
  leaves half a PDF. The previous version of the file is kept in the backups folder
  (last 40 saves, at most 6 GB; Settings > Open backups folder). Unsaved work is copied every 45 s
  (every 2 minutes for files over 150 MB) and offered back on the start screen after a crash. A file on a folder you can't
  write to opens "Read-only": use Save as.
  Deleted pages, redacted content and flattened markups are not left hidden inside
  the saved file. A file protected with a password, or with print/edit limits only,
  keeps that protection when saved (Protect > Remove password takes it off).
  Links inside a PDF: web and e-mail links open in your browser only after you are asked
  (the real address and its site are shown - a link's words can say one thing and go
  somewhere else); links to programs, files or network folders are never opened (a PDF
  from outside can't start anything on this PC) - a message says so.
  Make your own links: Edit > Link, drag a box over what is to be clicked (a sheet
  number, a reference) and choose a web page, an e-mail address or a page of this file.
  With the Link tool on, every link on the page shows; click one to change or delete it.

  The editing engine refreshes itself if its PDF library reports too many internal errors
  (a protection against a fault in that library): your work is kept, undo starts again.

KNOWN LIMITS
  - Edit text works line by line, not whole paragraphs that re-flow.
  - OCR quality: very good on clean office scans; poor photocopies, faxes and
    handwriting will have mistakes (true of every OCR engine).
  - Files made searchable before 0.8.0: their hidden text sits a little above the words
    (selections and highlights look high). Run OCR on those pages again to fix it.
  - Digitally signed files: markups, page turns and OCR are added after the signature,
    so it stays valid ("changed since signing"). Deleting pages, redacting or editing
    text rewrites the file: you are asked first, and "Save a copy" keeps the signed one.
  - Export: a scan's bold text and exact font sizes are estimates; Word can't take a
    table wider than 63 columns (it is split into parts).
  - Only one person per file at a time (no shared live markups yet).

ENGINES & LICENCES
  PDFium (Apache-2.0) draws the pages; MuPDF (AGPL-3.0) edits and saves; Tesseract
  (Apache-2.0) reads scans. MuPDF's AGPL licence is fine for in-house use; whoever passes
  a copy on to anyone else (another company, a home PC) must pass its source with it -
  it is the "source" zip published with each version - or buy a commercial MuPDF licence.
  All licences: Settings > About > Licences.
