"""Text libraries for make_corpus.py: UAE-style BOQ items, specification clauses, letters."""

PROJECT = "Residential Tower (2B+G+12) on Plot JVC-0512, Jumeirah Village Circle, Dubai"
PROJECT_SHORT = "Residential Tower - Plot JVC-0512"
TENDER_REF = "Tender Ref. T-2611"
CONTRACTOR = "Gulf Coast Contracting LLC"
CONSULTANT = "Al Noor Engineering Consultants"
CLIENT = "Emirates Horizon Developments"

# (description, unit, qty_min, qty_max, rate_min, rate_max); '#' prefix = sub-heading row
BOQ_LIB = {
    "EXCAVATION AND EARTHWORK": [
        "#Excavation",
        ("Excavate for foundation pits in any material other than rock, not exceeding 1.50m deep, "
         "commencing from reduced level, including trimming sides, levelling and compacting bottoms "
         "and keeping excavations free from water", "m3", 250, 3800, 18, 32),
        ("Ditto, exceeding 1.50m but not exceeding 3.00m deep", "m3", 120, 1600, 22, 38),
        ("Excavate trenches for ground beams and tie beams, not exceeding 1.00m deep", "m3", 40, 600, 20, 35),
        ("Allow for dewatering and keeping all excavations free from ground water, including provision "
         "of pumps, wellpoints, settling tanks and discharge to an approved location, all in accordance "
         "with Dubai Municipality requirements and the Specification", "Item", None, None, 85000, 240000),
        "#Filling",
        ("Backfill around foundations with approved selected excavated material, deposited and compacted "
         "in layers not exceeding 250mm thick to 95% maximum dry density (Modified Proctor)", "m3", 300, 2400, 14, 26),
        ("Imported approved granular fill material deposited and compacted in layers not exceeding 200mm "
         "thick to make up levels under ground floor slab", "m3", 150, 1200, 38, 60),
        ("Remove surplus excavated material from site to an approved tip, including all tipping charges "
         "and municipality fees", "m3", 400, 5200, 12, 24),
        ("Anti-termite soil treatment applied to bottoms and sides of excavations and to the surface of "
         "filling under slab on grade, with a ten year guarantee", "m2", 900, 6500, 6, 12),
        ("Polyethylene sheet 1000 gauge laid over compacted fill with 300mm laps sealed with tape", "m2",
         800, 5200, 3, 7),
    ],
    "CONCRETE WORK": [
        "#Plain concrete",
        ("Plain concrete grade C15 blinding, 75mm thick, under foundations and ground beams, laid on "
         "compacted ground", "m2", 600, 4200, 22, 34),
        "#Reinforced concrete",
        ("Reinforced concrete grade C40/20 with sulphate resisting cement in isolated footings, including "
         "vibrating, curing and protection", "m3", 120, 950, 420, 560),
        ("Ditto in raft foundation exceeding 600mm thick", "m3", 800, 3600, 400, 520),
        ("Ditto in ground beams and tie beams", "m3", 60, 480, 450, 590),
        ("Reinforced concrete grade C50/20 in columns, rectangular, sectional area not exceeding 0.25m2, "
         "including forming chamfers 20x20mm to all exposed arrises", "m3", 40, 380, 520, 680),
        ("Reinforced concrete grade C45/20 in suspended post-tensioned slabs 250mm thick, including "
         "forming openings for services not exceeding 0.10m2 each and all necessary sleeves and inserts",
         "m3", 300, 2600, 480, 620),
        ("Ditto in staircase flights and landings", "m3", 15, 120, 560, 720),
        ("Ditto in core walls and shear walls 300mm thick", "m3", 90, 760, 500, 650),
    ],
    "REINFORCEMENT AND FORMWORK": [
        ("High yield deformed steel reinforcement bars to BS 4449 Grade B500B, cut, bent and fixed, "
         "including tying wire, spacers, chairs and laps", "kg", 45000, 980000, 2.8, 3.9),
        ("Fabric reinforcement A252 mesh to BS 4483 with 200mm laps", "m2", 500, 4200, 14, 22),
        ("Formwork to sides of foundations and ground beams, including all necessary strutting and propping",
         "m2", 400, 3600, 28, 45),
        ("Formwork to soffits of suspended slabs, horizontal, height to soffit not exceeding 3.50m", "m2",
         1500, 14000, 38, 55),
        ("Formwork to columns, rectangular, smooth fair face finish", "m2", 300, 2800, 42, 60),
        ("Cast-in water stop PVC 230mm wide in construction joints of basement walls, including welded joints",
         "m", 120, 900, 48, 75),
    ],
    "WATERPROOFING": [
        ("Two coats of bitumen-based waterproofing paint applied to all surfaces of substructure concrete in "
         "contact with soil", "m2", 1200, 8800, 9, 16),
        ("Supply and apply 4mm thick torch-applied APP modified bituminous membrane to underside of raft, "
         "including 50mm thick protective screed, laps, upstands and all accessories, with a ten year "
         "joint guarantee from the applicator and the manufacturer", "m2", 900, 4200, 42, 68),
        ("Protection board 6mm thick fixed to vertical waterproofing with compatible adhesive", "m2", 600,
         3800, 12, 19),
        ("Cementitious crystalline waterproofing coating to internal faces of water tanks, two coats, "
         "including surface preparation", "m2", 80, 650, 55, 85),
    ],
    "MASONRY": [
        ("200mm thick hollow concrete blockwork in cement mortar 1:4, 7N/mm2 compressive strength, in "
         "external walls, including galvanised wire mesh reinforcement every third course", "m2", 1500,
         9800, 62, 85),
        ("150mm thick ditto in internal partitions", "m2", 1200, 8600, 52, 70),
        ("100mm thick solid concrete blockwork ditto in shafts and duct enclosures", "m2", 300, 2100, 48, 64),
        ("Precast concrete lintels 200x200mm reinforced with 2T12 bars, including 200mm bearing at each end",
         "m", 250, 1800, 65, 90),
        ("Movement joint 20mm wide filled with compressible filler board and sealed both sides with "
         "polysulphide sealant", "m", 180, 1500, 28, 42),
    ],
    "PLASTERING AND PAINTING": [
        ("12mm thick two-coat cement plaster to internal walls, finished smooth, including angle beads, stop "
         "beads and expanded metal lath at junctions of dissimilar materials", "m2", 4000, 28000, 22, 32),
        ("20mm thick three-coat cement plaster to external walls with waterproofing additive, including "
         "plaster stops and drip grooves", "m2", 2500, 12000, 30, 44),
        ("Prepare and apply one coat alkali-resisting primer and two finishing coats of washable emulsion "
         "paint to plastered walls", "m2", 4000, 30000, 12, 19),
        ("Textured acrylic external paint system comprising primer, textured base coat and two top coats, "
         "colour to Architect's approval", "m2", 2500, 12000, 24, 36),
    ],
    "FLOOR AND WALL TILING": [
        ("Supply and install 600x600mm glazed porcelain floor tiles, 10mm thick, from an approved "
         "manufacturer, laid on 40mm thick cement sand screed, including grout, spacers, cutting, "
         "protection and final cleaning", "m2", 1800, 14000, 85, 140),
        ("Ditto 100mm high skirting to match floor tiles, including cove pieces at corners", "m", 1500,
         9800, 22, 36),
        ("300x600mm ceramic wall tiles fixed with approved tile adhesive to blockwork walls in toilets and "
         "kitchens, full height, including corner trims, grout and silicone sealant at junctions with "
         "sanitary ware", "m2", 1200, 7800, 75, 115),
        ("Marble threshold 20mm thick, 200mm wide, polished, with bevelled edges, bedded in mortar", "m",
         120, 950, 95, 160),
        ("Anti-slip unglazed porcelain tiles 300x300mm, R11 slip rating, to balconies and wet areas laid "
         "to falls", "m2", 300, 2400, 95, 145),
    ],
    "CEILINGS": [
        ("Suspended gypsum board ceiling, 12.5mm thick moisture resistant board on concealed galvanised "
         "steel grid, including access panels 600x600mm where shown on drawings", "m2", 1500, 11000, 62, 92),
        ("Mineral fibre lay-in ceiling tiles 600x600mm on exposed tee grid in corridors and service areas",
         "m2", 400, 3200, 48, 70),
        ("Gypsum board bulkhead 300mm deep, including framing and corner beads", "m", 300, 2600, 55, 85),
    ],
    "DOORS AND IRONMONGERY": [
        ("Single leaf solid core timber flush door 900x2100mm, 45mm thick, with hardwood lipping and oak "
         "veneer finish, including hardwood frame and architraves, as door type D1", "nr", 40, 420, 1450, 2300),
        ("Double leaf 60 minute fire rated timber door 1800x2400mm with vision panel, intumescent strips and "
         "overhead door closers, complete with frame, as door schedule type FD2", "No", 6, 60, 6200, 9800),
        ("Steel door 1000x2100mm to services rooms, polyester powder coated, with louvres", "nr", 8, 70,
         2800, 4200),
        ("Ironmongery set IR-03 comprising lever handles, mortice sashlock, three pairs of stainless steel "
         "hinges, door stop and signage", "nr", 40, 420, 650, 1100),
    ],
    "EXTERNAL WORKS": [
        ("Interlocking concrete paving blocks 80mm thick, grey, laid on 50mm sand bed over 200mm compacted "
         "aggregate sub-base", "m2", 800, 6500, 62, 90),
        ("Precast concrete kerb 150x300mm laid on C20 concrete foundation and haunching", "m", 300, 2400, 48, 70),
        ("uPVC drainage pipe 150mm diameter laid in trench on 150mm granular bedding, including excavation, "
         "backfilling and testing", "m", 200, 1600, 85, 130),
        ("Precast concrete manhole 1200mm internal diameter, average 1.50m deep, with heavy duty ductile "
         "iron cover and frame", "nr", 6, 48, 4800, 7600),
        ("Rate only: Extra over excavation for breaking out rock", "m3", None, None, 65, 95),
    ],
    "PRELIMINARIES": [
        ("Provide performance bond equal to 10% of the Contract Price valid until the issue of the "
         "Taking-Over Certificate", "Item", None, None, 120000, 320000),
        ("Contractor's All Risks insurance policy as required by the Conditions of Contract", "Item", None,
         None, 90000, 210000),
        ("Allow for site establishment including temporary offices for the Engineer, stores, welfare "
         "facilities, hoarding 2.40m high around the site perimeter and site signboard", "LS", None, None,
         180000, 420000),
        ("Allow for temporary electricity and water supply for the Works including all connection charges "
         "and consumption", "LS", None, None, 95000, 260000),
        ("Allow for setting out the Works and survey by a licensed surveyor", "Item", None, None, 25000, 60000),
    ],
    "PROVISIONAL SUMS": [
        ("Provisional Sum for testing and commissioning by an independent third party testing agency",
         "Sum", None, None, 150000, 150000),
        ("Provisional Sum for Dubai Electricity and Water Authority (DEWA) connection charges", "Sum", None,
         None, 350000, 350000),
        ("Provisional Sum for Civil Defence approvals and inspections", "Sum", None, None, 75000, 75000),
    ],
}

EXTRA_CLAUSES = [
    ", all in accordance with Specification Section {sec} and as shown on drawing {dwg}",
    ", including all necessary cutting, waste, temporary works and protection until handover",
    ", the rate shall include for all labour, materials, plant, wastage and overheads",
    ", measured net with no deduction for voids not exceeding 0.50m2",
    ", including samples, mock-ups and shop drawings for the Engineer's approval prior to procurement",
    ", and making good all disturbed surfaces on completion",
]

SPEC_SECTIONS = ["03 30 00", "07 11 13", "09 30 13", "04 22 00", "31 23 16", "09 91 23"]
DRAWINGS = ["A-201", "A-305", "S-110", "S-212", "A-410", "C-102"]

DOOR_LOCATIONS = ["Bedroom 1", "Bedroom 2", "Master Bedroom", "Kitchen", "Living / Dining", "Toilet",
                  "Maid's Room", "Store", "Laundry", "Corridor", "Electrical Room", "Staircase S1",
                  "Lobby", "Refuse Room", "Pump Room"]

# ---------------------------------------------------------------- spec ----
# Markup: {b:..} bold, {i:..} italic, {u:..} underline, {bi:..}, {s:..} superscript

SPEC = [
    ("h1", "PART 1 - GENERAL"),
    ("h2", "1.1 SUMMARY"),
    ("cl", "1.1.1", "This Section includes ceramic and porcelain tiling to floors, walls and skirtings, "
     "including setting beds, adhesives, grout, movement joints and accessories, as indicated on the "
     "Drawings and in the Finishes Schedule."),
    ("cl", "1.1.2", "Related Sections include the following:"),
    ("bul", "Section 03 30 00 - Cast-in-Place Concrete, for concrete substrates and tolerances."),
    ("bul", "Section 07 11 13 - Bituminous Damp-proofing, for membranes below screeds in wet areas."),
    ("bul", "Section 09 91 23 - Interior Painting, for adjacent finishes and protection."),
    ("cl", "1.1.3", "The Contractor {b:shall} coordinate the tiling layout with the positions of floor drains, "
     "access panels, sanitary fittings and electrical outlets {i:before} commencing the Works."),
    ("h2", "1.2 REFERENCES"),
    ("cl", "1.2.1", "The following standards apply to the Works of this Section. Where a conflict exists, "
     "the more stringent requirement shall govern:"),
    ("bul", "{i:BS EN 14411} - Ceramic tiles: definition, classification, characteristics and marking."),
    ("bul", "{i:BS EN 12004} - Adhesives for ceramic tiles: requirements and test methods."),
    ("bul", "{i:BS EN 13888} - Grout for tiles: requirements, evaluation of conformity and designation."),
    ("bul", "{i:BS 5385-3} - Wall and floor tiling: code of practice for the design and installation of "
     "internal and external ceramic floor tiling."),
    ("bul", "{i:ANSI A137.1} - American National Standard Specifications for Ceramic Tile."),
    ("cl", "1.2.2", "Dubai Municipality and Dubai Civil Defence regulations current at the date of tender "
     "shall be complied with in all respects."),
    ("h2", "1.3 SUBMITTALS"),
    ("h3", "Product Data"),
    ("cl", "1.3.1", "Submit manufacturer's technical data sheets for each type of tile, adhesive, grout, "
     "sealant and trim, indicating compliance with the referenced standards and the {u:Specification}."),
    ("cl", "1.3.2", "Submit installation instructions and the manufacturer's recommendations for "
     "substrate preparation, curing periods and cleaning."),
    ("h3", "Samples"),
    ("cl", "1.3.3", "Submit three full-size samples of each tile type and colour, mounted on boards, "
     "together with grout colour samples. Approved samples will be retained on site as the standard for "
     "acceptance of the Works."),
    ("cl", "1.3.4", "Construct a mock-up of not less than 4 m{s:2} of floor tiling and 4 m{s:2} of wall "
     "tiling in a location agreed with the Engineer. The approved mock-up may form part of the "
     "permanent Works."),
    ("h3", "Shop Drawings"),
    ("cl", "1.3.5", "Submit setting-out drawings at a scale of 1:50 showing tile layout, starting points, "
     "movement joints, changes of level and junctions with other finishes."),
    ("h2", "1.4 QUALITY ASSURANCE"),
    ("cl", "1.4.1", "The tiling subcontractor shall have not less than {b:five years} documented experience "
     "of installations of similar scope and shall be approved by the Engineer."),
    ("cl", "1.4.2", "Obtain each type of tile from a single source and a single production batch to ensure "
     "consistency of colour, shade and calibre. Batch numbers shall be recorded and submitted."),
    ("cl", "1.4.3", "Adhesives, grouts and sealants shall be obtained from {u:one manufacturer} to ensure "
     "compatibility of the installation system."),
    ("h2", "1.5 DELIVERY, STORAGE AND HANDLING"),
    ("cl", "1.5.1", "Deliver materials in the manufacturer's original unopened packaging, clearly labelled "
     "with product name, grade, shade and batch number."),
    ("cl", "1.5.2", "Store tiles and setting materials in a dry, shaded and ventilated area at temperatures "
     "between 5 and 35 degrees Celsius. Protect cementitious materials from moisture."),
    ("h2", "1.6 WARRANTY"),
    ("cl", "1.6.1", "Provide a joint warranty from the tiling subcontractor and the adhesive manufacturer "
     "for a period of {b:ten (10) years} from the date of the Taking-Over Certificate against loss of "
     "adhesion, cracking and water penetration."),
    ("h1", "PART 2 - PRODUCTS"),
    ("h2", "2.1 TILES"),
    ("cl", "2.1.1", "Porcelain floor tiles shall be fully vitrified, Group BIa to {i:BS EN 14411}, with water "
     "absorption not exceeding 0.5% and breaking strength not less than 1300 N."),
    ("cl", "2.1.2", "Ceramic wall tiles shall be glazed, Group BIII, with a minimum thickness of 8mm and "
     "dimensional tolerance within plus or minus 0.5%."),
    ("cl", "2.1.3", "Tile types, sizes and locations shall be as listed in Table 1 below and in the "
     "Finishes Schedule."),
    ("table",),
    ("h2", "2.2 SETTING MATERIALS"),
    ("cl", "2.2.1", "Floor screed shall be cement and sand 1:4 by volume, minimum 40mm thick, with a "
     "polypropylene fibre additive at 0.9 kg/m{s:3}."),
    ("cl", "2.2.2", "Tile adhesive shall be improved cementitious adhesive Class C2TE S1 to "
     "{i:BS EN 12004} for porcelain tiles, and Class C1T for ceramic wall tiles."),
    ("cl", "2.2.3", "Grout shall be cementitious Class CG2WA to {i:BS EN 13888} for joints up to 6mm. "
     "Epoxy grout Class RG shall be used in kitchens, laundries and plant rooms."),
    ("h2", "2.3 ACCESSORIES"),
    ("cl", "2.3.1", "Movement joint profiles shall be stainless steel grade 316 with replaceable "
     "neoprene inserts, sized to suit the tile thickness."),
    ("cl", "2.3.2", "Edge and corner trims shall be anodised aluminium or stainless steel, colour and "
     "profile to the Architect's approval."),
    ("cl", "2.3.3", "Sealants at perimeter and movement joints shall be mould-resistant silicone, colour "
     "matched to the grout."),
    ("figure",),
    ("h1", "PART 3 - EXECUTION"),
    ("h2", "3.1 EXAMINATION"),
    ("cl", "3.1.1", "Examine substrates for compliance with flatness tolerances of 3mm under a 3m "
     "straightedge. Report unsatisfactory conditions in writing and do not proceed until they have been "
     "corrected."),
    ("cl", "3.1.2", "Concrete substrates shall have cured for not less than 28 days and screeds for not "
     "less than 7 days before tiling commences."),
    ("h2", "3.2 PREPARATION"),
    ("cl", "3.2.1", "Remove laitance, dust, oil and curing compounds from substrates by mechanical means. "
     "Apply primer where recommended by the adhesive manufacturer."),
    ("cl", "3.2.2", "Lay screeds to falls of {b:1:100} towards floor drains in wet areas. Check falls with "
     "water before tiling and rectify ponding exceeding 2mm."),
    ("h2", "3.3 INSTALLATION"),
    ("cl", "3.3.1", "Set out tiling from centre lines so that cut tiles at perimeters are not less than "
     "half a tile wide. Align joints in floors and walls where tile sizes permit."),
    ("cl", "3.3.2", "Apply adhesive using the solid bed method to achieve not less than {b:95% coverage} in "
     "wet areas and 85% elsewhere. Back-butter tiles exceeding 600mm in any dimension."),
    ("cl", "3.3.3", "Joint widths shall be 2mm for wall tiles and 3mm for floor tiles unless otherwise "
     "shown. Remove spacers and clean joints before grouting."),
    ("cl", "3.3.4", "Form movement joints at perimeters, over structural joints, at changes of substrate "
     "and at intervals not exceeding 6m in each direction, so that bays do not exceed 36 m{s:2}."),
    ("h3", "Tolerances"),
    ("cl", "3.3.5", "Finished tiling shall be flat within 2mm under a 2m straightedge, with lipping "
     "between adjacent tiles not exceeding 0.5mm for joints up to 3mm."),
    ("h2", "3.4 CLEANING AND PROTECTION"),
    ("cl", "3.4.1", "Clean tiled surfaces on completion using neutral cleaning agents recommended by the "
     "manufacturer. {u:Acid-based cleaners shall not be used}."),
    ("cl", "3.4.2", "Protect finished floors from traffic for 48 hours and cover with hardboard or "
     "corrugated plastic sheeting until handover."),
    ("h2", "3.5 MEASUREMENT"),
    ("cl", "3.5.1", "Tiling shall be measured net in m{s:2} on the finished face. Skirtings shall be "
     "measured in linear metres. No deduction shall be made for openings not exceeding 0.50 m{s:2}."),
    ("cl", "3.5.2", "Rates shall include for screeds, adhesives, grout, trims, movement joints, cutting, "
     "waste, cleaning and protection, unless measured separately in the Bills of Quantities."),
]

SPEC_FILLER = [
    "The Contractor shall provide all labour, materials, plant and supervision necessary to complete the "
    "Works in accordance with the Contract Documents.",
    "Any deviation from the specified products shall be submitted as a substitution request with full "
    "technical comparison and cost implications for the Engineer's review.",
    "Work shall be carried out by skilled operatives under the continuous supervision of a competent "
    "foreman experienced in this type of work.",
    "Inspection and testing shall be carried out at the frequencies stated in the Inspection and Test Plan "
    "approved by the Engineer, and records shall be maintained on site.",
    "Defective work shall be removed and replaced at the Contractor's cost, including all consequential "
    "making good of adjacent finishes.",
    "Ambient temperatures above 35 degrees Celsius require shading of the work area and the use of "
    "retarded setting materials in accordance with the manufacturer's written recommendations.",
    "Materials delivered to site shall be inspected jointly with the Engineer's representative and a Material "
    "Inspection Request shall be raised for each consignment before use in the Works.",
    "The Contractor shall maintain a register of approved samples, shop drawings and material submittals, "
    "and shall make it available to the Engineer on request.",
    "Where the Drawings and this Specification conflict, the Contractor shall seek clarification from the "
    "Engineer before proceeding; no claim will be entertained for work carried out without such clarification.",
    "Health and safety requirements of the Contract, including permits to work and method statements, shall "
    "apply to all activities described in this Section.",
    "Waste materials, packaging and offcuts shall be removed from the working areas daily and disposed of in "
    "accordance with the approved site waste management plan.",
    "Protection of adjacent finishes, fixtures and services shall be provided and maintained until completion "
    "of the Works, and any damage shall be made good at the Contractor's expense.",
]

TILE_TABLE = [
    ["Type", "Location", "Size (mm)", "Finish", "Slip Rating"],
    ["PT-01", "Living, dining and corridors", "600 x 600", "Matt", "R10"],
    ["PT-02", "Bathrooms and toilets (floor)", "300 x 600", "Matt", "R11"],
    ["CT-01", "Bathroom walls, full height", "300 x 600", "Gloss", "-"],
    ["CT-02", "Kitchen splashback", "100 x 300", "Gloss", "-"],
    ["PT-03", "Balconies and terraces", "600 x 600", "Structured", "R11"],
    ["PT-04", "Lobby and lift lobbies", "1200 x 600", "Polished", "R9"],
]

LETTER_BODY = [
    "We refer to the above-mentioned tender and to the Consultant's Tender Addendum No. 3 dated 14 October "
    "2026, and we are pleased to submit herewith our responses to the post-tender clarifications raised "
    "during the meeting held at your office on 21 October 2026.",
    "Our tender price of AED 186,450,000.00 (United Arab Emirates Dirhams One Hundred Eighty Six Million Four "
    "Hundred Fifty Thousand only), excluding VAT, remains valid for a period of ninety (90) days from the "
    "revised tender submission date. The price includes all items listed in Addendum No. 3 save for the "
    "qualifications stated in the enclosed schedule.",
    "With regard to the programme, we confirm that the overall construction period of thirty (30) months "
    "from the Commencement Date can be achieved, subject to the issue of the enabling works permit and "
    "access to the site free from obstruction. A revised baseline programme will be submitted within "
    "twenty-eight (28) days of the Letter of Award.",
    "We further confirm that the proposed key staff named in our technical submission will be dedicated "
    "to the Project on a full-time basis and will not be replaced without the prior written approval of "
    "the Engineer.",
    "We trust the above and the enclosed documents are in order. Should you require any further "
    "information, please do not hesitate to contact the undersigned.",
]

LETTER_ENCLOSURES = [
    "Schedule of Clarifications and Responses (12 pages)",
    "Revised Bill No. 4 - Finishes, priced",
    "Schedule of Qualifications and Exclusions",
    "Updated Tender Programme, Revision B",
]

TWO_COL = [
    ("h2", "1. Scope of this Addendum"),
    ("p", "This Addendum forms part of the Tender Documents and shall be read together with the Instructions "
          "to Tenderers, the Conditions of Contract, the Specification and the Drawings. Tenderers shall "
          "acknowledge receipt of this Addendum in the Form of Tender."),
    ("p", "Where this Addendum conflicts with any earlier tender document, this Addendum shall prevail. All "
          "other requirements of the Tender Documents remain unchanged."),
    ("h2", "2. Tender Submission Date"),
    ("p", "The tender submission date is extended to Thursday 12 November 2026 at 14:00 hours local time. "
          "Late submissions will not be considered under any circumstances."),
    ("p", "Tenders shall be submitted in two separate envelopes marked Technical Proposal and Commercial "
          "Proposal, each containing one original, two copies and an electronic copy on a USB drive."),
    ("h2", "3. Revised Bills of Quantities"),
    ("p", "Bill No. 3 - Superstructure and Bill No. 4 - Finishes have been reissued in full. Tenderers shall "
          "price the revised bills and discard the superseded pages. Item descriptions shall not be altered."),
    ("p", "Quantities for blockwork and plaster have been remeasured following the revision of the "
          "architectural layouts. Rates for these items shall allow for the revised wall thicknesses."),
    ("h2", "4. Site Visit"),
    ("p", "A second site visit will be held on Monday 2 November 2026 at 10:00 hours. Tenderers wishing to "
          "attend shall confirm the names of their representatives by email not later than 48 hours before "
          "the visit. Personal protective equipment is mandatory."),
    ("h2", "5. Queries"),
    ("p", "All queries shall be submitted in writing to the Consultant. Responses will be issued to all "
          "tenderers without disclosing the source of the query. Verbal clarifications are not binding."),
    ("p", "The final date for receipt of queries is Thursday 5 November 2026. Queries received after this "
          "date may not be answered."),
    ("h2", "6. Advance Payment"),
    ("p", "An advance payment of ten percent of the Contract Price will be made against an unconditional "
          "advance payment guarantee issued by a bank operating in the United Arab Emirates, to be recovered "
          "in equal instalments from interim payments."),
]

ARABIC_PAIRS = [
    ("This tender is subject to the provisions of the Civil Transactions Law of the United Arab Emirates.",
     "تخضع هذه المناقصة لأحكام قانون المعاملات المدنية لدولة الإمارات العربية المتحدة."),
    ("The tenderer shall submit the Bills of Quantities fully priced together with the technical and "
     "commercial proposals.",
     "يجب على مقدم العطاء تقديم جداول الكميات مسعرة بالكامل مع العرض الفني والعرض المالي."),
    ("All prices shall be in UAE Dirhams and shall exclude Value Added Tax unless otherwise stated.",
     "تكون جميع الأسعار بالدرهم الإماراتي ولا تشمل ضريبة القيمة المضافة ما لم يذكر خلاف ذلك."),
    ("The closing time for receipt of tenders is two o'clock in the afternoon on Thursday.",
     "آخر موعد لاستلام العطاءات هو الساعة الثانية ظهرا من يوم الخميس."),
    ("The Employer reserves the right to reject any tender without giving reasons.",
     "يحتفظ صاحب العمل بالحق في رفض أي عطاء دون إبداء الأسباب."),
]
ARABIC_MIXED = "رقم المناقصة T-2611 وقيمة ضمان العطاء 500,000 درهم إماراتي."

CONDITIONS = [
    ("h2", "Sub-Clause 4.2 Performance Security"),
    ("p", "The Contractor shall obtain, at his own cost, a Performance Security for proper performance of the "
          "Contract in the amount of ten percent (10%) of the Accepted Contract Amount. The Performance "
          "Security shall be issued by a bank licensed by the Central Bank of the United Arab Emirates and "
          "shall be in the form annexed to these Particular Conditions. The Contractor shall deliver the "
          "Performance Security to the Employer within twenty-eight (28) days after receiving the Letter of "
          "Acceptance and shall ensure that it remains valid and enforceable until the Contractor has executed "
          "and completed the Works and remedied any defects."),
    ("p", "The Employer shall not make a claim under the Performance Security except for amounts to which the "
          "Employer is entitled under the Contract in the event of:"),
    ("li", "(a)", "failure by the Contractor to extend the validity of the Performance Security as required by "
                  "this Sub-Clause, in which event the Employer may claim the full amount of the Performance "
                  "Security;"),
    ("li", "(b)", "failure by the Contractor to pay the Employer an amount due, as either agreed by the "
                  "Contractor or determined by the Engineer, within forty-two (42) days after such agreement "
                  "or determination;"),
    ("li", "(c)", "failure by the Contractor to remedy a default within forty-two (42) days after receiving the "
                  "Employer's notice requiring the default to be remedied."),
    ("h2", "Sub-Clause 14.3 Application for Interim Payment Certificates"),
    ("p", "The Contractor shall submit a Statement to the Engineer after the end of each month, in a form "
          "approved by the Engineer, showing in detail the amounts to which the Contractor considers himself "
          "to be entitled, together with supporting documents which shall include the monthly progress "
          "report. The Statement shall include the estimated contract value of the Works executed up to the "
          "end of the month, any amounts to be added or deducted for changes in legislation and changes in "
          "cost, and any amount to be deducted for retention calculated at the rate of ten percent (10%) of "
          "the amount due, until the amount so retained reaches five percent (5%) of the Accepted Contract "
          "Amount."),
    ("p", "Retention Money shall be released in two equal halves: the first half upon the issue of the "
          "Taking-Over Certificate for the whole of the Works, and the second half upon the expiry of the "
          "Defects Notification Period, provided that the Contractor has completed all outstanding work and "
          "remedied all notified defects to the satisfaction of the Engineer."),
    ("h2", "Sub-Clause 20.1 Contractor's Claims"),
    ("p", "If the Contractor considers himself to be entitled to any extension of the Time for Completion or "
          "any additional payment, the Contractor shall give notice to the Engineer describing the event or "
          "circumstance giving rise to the claim. The notice shall be given as soon as practicable, and not "
          "later than twenty-eight (28) days after the Contractor became aware, or should have become aware, "
          "of the event or circumstance. If the Contractor fails to give notice within such period, the Time "
          "for Completion shall not be extended, the Contractor shall not be entitled to additional payment, "
          "and the Employer shall be discharged from all liability in connection with the claim, save to the "
          "extent that such discharge is contrary to the mandatory provisions of the governing law."),
]

MINUTES_ATTENDEES = [
    ["Name", "Company", "Designation"],
    ["Eng. Khalid Mansour", CONSULTANT, "Project Manager"],
    ["Eng. Rania Aziz", CONSULTANT, "Senior Quantity Surveyor"],
    ["Mr. Sameer Joshi", CLIENT, "Development Director"],
    ["Eng. Omar Haddad", CONTRACTOR, "Tendering Manager"],
    ["Eng. Fatima Al Suwaidi", CONTRACTOR, "Technical Engineer"],
]
MINUTES_ITEMS = [
    ("4.1", "The Consultant confirmed that the revised architectural drawings (Revision C) supersede all "
            "previous issues and will be formally transmitted with Addendum No. 4."),
    ("4.2", "The Contractor raised the discrepancy between the door schedule and the BOQ quantities for fire "
            "rated doors. The Consultant agreed to remeasure and issue a corrected Bill No. 5."),
    ("4.3", "The Client requested that alternative tile suppliers be proposed with a cost comparison. The "
            "Contractor will submit three alternatives with samples."),
    ("4.4", "Programme: the Contractor confirmed that the 30-month duration is achievable subject to the "
            "enabling works permit being obtained by the Client before the Commencement Date."),
]
MINUTES_ACTIONS = [
    ["No.", "Action", "By", "Due Date"],
    ["1", "Issue Addendum No. 4 with Revision C drawings", "Consultant", "03-Nov-2026"],
    ["2", "Remeasure fire rated doors and reissue Bill No. 5", "Consultant", "05-Nov-2026"],
    ["3", "Submit alternative tile suppliers with samples", "Contractor", "10-Nov-2026"],
    ["4", "Confirm enabling works permit status", "Client", "05-Nov-2026"],
]
