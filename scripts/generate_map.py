import math
from pathlib import Path

import requests
from PIL import Image, ImageDraw, ImageFont


# Use the mapped building centroid rather than the roadside address node.
VENUE_LAT = 43.125929
VENUE_LON = -80.7689616

WIDTH = 1200
HEIGHT = 820
PAD_LAT = 0.0062
PAD_LON = 0.0082
PAD_PX = 30

OUTPUT = Path("site-redesign/assets/images/woodstock-openstreetmap.png")

TARGET_LABEL_POINTS = {
    "Main Street": (43.12577, -80.7710),
    "Dundas Street": (43.12786, -80.77415),
    "Ingersoll Road": (43.12472, -80.77355),
    "Mill Street": (43.12645, -80.7646),
    "Oxford Street": (43.13072, -80.76602),
    "Park Row": (43.12453, -80.7657),
}

ROAD_LABEL_STYLE = {
    "Main Street": {"font_size": 34, "fill": "#696969", "stroke": "#efefef", "stroke_width": 5},
    "Dundas Street": {"font_size": 20, "fill": "#696969", "stroke": "#efefef", "stroke_width": 4},
    "Ingersoll Road": {"font_size": 20, "fill": "#696969", "stroke": "#efefef", "stroke_width": 4},
    "Mill Street": {"font_size": 20, "fill": "#696969", "stroke": "#efefef", "stroke_width": 4},
    "Oxford Street": {"font_size": 20, "fill": "#696969", "stroke": "#efefef", "stroke_width": 4},
    "Park Row": {"font_size": 20, "fill": "#696969", "stroke": "#efefef", "stroke_width": 4},
}


def fetch_map_elements():
    south = VENUE_LAT - PAD_LAT
    north = VENUE_LAT + PAD_LAT
    west = VENUE_LON - PAD_LON
    east = VENUE_LON + PAD_LON

    query = f"""
    [out:json][timeout:25];
    (
      way["highway"]({south},{west},{north},{east});
      way["waterway"]({south},{west},{north},{east});
      way["railway"]({south},{west},{north},{east});
      way["landuse"="park"]({south},{west},{north},{east});
      way["leisure"="park"]({south},{west},{north},{east});
      way["natural"="water"]({south},{west},{north},{east});
    );
    out geom tags;
    """
    response = requests.post(
        "https://overpass-api.de/api/interpreter",
        data=query.encode("utf-8"),
        headers={"User-Agent": "BlankSpace redesign custom illustrated map"},
        timeout=60,
    )
    response.raise_for_status()
    return response.json()["elements"]


def mercator_y(lat):
    lat_rad = math.radians(lat)
    return math.log(math.tan(math.pi / 4 + lat_rad / 2))


def project(lat, lon):
    west = VENUE_LON - PAD_LON
    east = VENUE_LON + PAD_LON
    south = VENUE_LAT - PAD_LAT
    north = VENUE_LAT + PAD_LAT
    x = PAD_PX + (lon - west) / (east - west) * (WIDTH - PAD_PX * 2)
    merc_north = mercator_y(north)
    merc_south = mercator_y(south)
    merc_point = mercator_y(lat)
    y = PAD_PX + (merc_north - merc_point) / (merc_north - merc_south) * (HEIGHT - PAD_PX * 2)
    return x, y


def points_from_geometry(geometry):
    return [project(point["lat"], point["lon"]) for point in geometry]


def categorize(elements):
    parks = []
    waters = []
    rails = []
    roads = []

    for element in elements:
        tags = element.get("tags", {})
        geometry = element.get("geometry")
        if not geometry:
            continue
        points = points_from_geometry(geometry)
        if tags.get("landuse") == "park" or tags.get("leisure") == "park":
            parks.append((tags, points))
        elif tags.get("natural") == "water" or tags.get("waterway"):
            waters.append((tags, points))
        elif tags.get("railway"):
            rails.append((tags, points))
        elif tags.get("highway"):
            roads.append((tags, points))

    return parks, waters, rails, roads


def distance_point_to_segment(point, start, end):
    px, py = point
    x1, y1 = start
    x2, y2 = end
    dx = x2 - x1
    dy = y2 - y1
    seg_len_sq = dx * dx + dy * dy
    if seg_len_sq == 0:
        return math.hypot(px - x1, py - y1), start, 0.0
    t = ((px - x1) * dx + (py - y1) * dy) / seg_len_sq
    t = max(0.0, min(1.0, t))
    nearest = (x1 + t * dx, y1 + t * dy)
    angle = math.degrees(math.atan2(dy, dx))
    if angle > 90:
        angle -= 180
    if angle < -90:
        angle += 180
    return math.hypot(px - nearest[0], py - nearest[1]), nearest, angle


def nearest_label_position(roads_by_name, road_name, target_latlon):
    target_point = project(*target_latlon)
    best = None
    for polyline in roads_by_name.get(road_name, []):
        for index in range(len(polyline) - 1):
            start = polyline[index]
            end = polyline[index + 1]
            distance, nearest, angle = distance_point_to_segment(target_point, start, end)
            if best is None or distance < best[0]:
                best = (distance, nearest, angle)
    if best is None:
        raise ValueError(f"No geometry found for {road_name}")
    return best[1], best[2]


def draw_rotated_text(base_image, text, position, angle, font, fill, stroke_fill, stroke_width):
    temp = Image.new("RGBA", (900, 240), (255, 255, 255, 0))
    draw = ImageDraw.Draw(temp)
    bbox = draw.textbbox(
        (0, 0),
        text,
        font=font,
        stroke_width=stroke_width,
    )
    text_width = bbox[2] - bbox[0]
    text_height = bbox[3] - bbox[1]
    text_x = (temp.width - text_width) // 2
    text_y = (temp.height - text_height) // 2 - 4
    draw.text(
        (text_x, text_y),
        text,
        font=font,
        fill=fill,
        stroke_width=stroke_width,
        stroke_fill=stroke_fill,
    )
    rotated = temp.rotate(angle, expand=True, resample=Image.Resampling.BICUBIC)
    px, py = position
    base_image.alpha_composite(rotated, (int(px - rotated.width / 2), int(py - rotated.height / 2)))


def draw_map():
    bg = "#efefef"
    park_fill = "#ebebeb"
    water_fill = "#d3d3d3"
    water_stroke = "#d3d3d3"
    local_road = "#ffffff"
    local_road_stroke = "#d7d7d7"
    major_road_fill = "#ffffff"
    major_road_edge = "#b3b3b3"
    rail_color = "#cfcfcf"
    pin = "#3b2724"
    pin_inner = "#f3c9d2"
    pin_core = "#fff7f9"

    major_names = set(TARGET_LABEL_POINTS.keys())

    elements = fetch_map_elements()
    parks, waters, rails, roads = categorize(elements)

    roads_by_name = {}
    for tags, polyline in roads:
        name = tags.get("name")
        if name:
            roads_by_name.setdefault(name, []).append(polyline)

    image = Image.new("RGBA", (WIDTH, HEIGHT), bg)
    draw = ImageDraw.Draw(image)

    for tags, polygon in parks:
        if len(polygon) >= 3:
            draw.polygon(polygon, fill=park_fill)

    for tags, polygon in waters:
        if tags.get("natural") == "water" and len(polygon) >= 3:
            draw.polygon(polygon, fill=water_fill)

    for tags, line in waters:
        if tags.get("waterway") and len(line) >= 2:
            draw.line(line, fill=water_stroke, width=10, joint="curve")
            draw.line(line, fill=water_fill, width=6, joint="curve")

    for tags, line in roads:
        name = tags.get("name", "")
        highway = tags.get("highway", "")
        if highway in {"service", "track", "path", "footway", "cycleway"}:
            continue
        if highway in {"secondary", "primary", "trunk", "primary_link", "secondary_link"} or name in major_names:
            continue
        draw.line(line, fill=local_road_stroke, width=6, joint="curve")
        draw.line(line, fill=local_road, width=4, joint="curve")

    for tags, line in rails:
        draw.line(line, fill=rail_color, width=2, joint="curve")
        for idx in range(len(line) - 1):
            x1, y1 = line[idx]
            x2, y2 = line[idx + 1]
            segment_length = math.hypot(x2 - x1, y2 - y1)
            if segment_length == 0:
                continue
            dash = 10
            gap = 8
            dx = (x2 - x1) / segment_length
            dy = (y2 - y1) / segment_length
            progress = 0
            while progress < segment_length:
                start = progress
                end = min(progress + dash, segment_length)
                draw.line(
                    [(x1 + dx * start, y1 + dy * start), (x1 + dx * end, y1 + dy * end)],
                    fill="#fafafa",
                    width=1,
                )
                progress += dash + gap

    for tags, line in roads:
        name = tags.get("name", "")
        highway = tags.get("highway", "")
        if highway in {"secondary", "primary", "trunk", "primary_link", "secondary_link"} or name in major_names:
            outer_width = 11 if name in {"Main Street", "Dundas Street", "Ingersoll Road", "Mill Street", "Oxford Street"} else 8
            inner_width = 9 if outer_width == 11 else 6
            draw.line(line, fill=major_road_edge, width=outer_width, joint="curve")
            draw.line(line, fill=major_road_fill, width=inner_width, joint="curve")

    georgia = "C:/Windows/Fonts/georgia.ttf"
    segoe = "C:/Windows/Fonts/segoeui.ttf"
    italic = "C:/Windows/Fonts/segoeuii.ttf"
    venue_font = ImageFont.truetype(georgia, 26)

    for road_name, latlon in TARGET_LABEL_POINTS.items():
        position, angle = nearest_label_position(roads_by_name, road_name, latlon)
        style = ROAD_LABEL_STYLE[road_name]
        font_path = georgia if road_name == "Main Street" else segoe
        font = ImageFont.truetype(font_path, style["font_size"])
        draw_rotated_text(
            image,
            road_name,
            position,
            angle,
            font,
            style["fill"],
            style["stroke"],
            style["stroke_width"],
        )

    park_font = ImageFont.truetype(italic, 18)
    for text, position in [
        ("Cedar Creek Park", project(43.1279, -80.777)),
        ("Downtown Woodstock", project(43.12655, -80.76465)),
    ]:
        bbox = draw.textbbox((0, 0), text, font=park_font)
        width = bbox[2] - bbox[0]
        height = bbox[3] - bbox[1]
        x, y = position
        draw.rounded_rectangle(
            (x - width / 2 - 10, y - height / 2 - 6, x + width / 2 + 10, y + height / 2 + 6),
            radius=12,
            fill=(239, 239, 239, 190),
        )
        draw.text((x, y), text, font=park_font, fill="#737373", anchor="mm")

    marker_x, marker_y = project(VENUE_LAT, VENUE_LON)
    draw.text(
        (marker_x, marker_y - 82),
        "Blank Space",
        font=venue_font,
        fill="#4f4f4f",
        stroke_width=4,
        stroke_fill="#efefef",
        anchor="mm",
    )
    radius = 32
    draw.ellipse((marker_x - radius, marker_y - radius - 24, marker_x + radius, marker_y + radius - 24), fill=pin)
    draw.polygon([(marker_x - 22, marker_y - 8), (marker_x + 22, marker_y - 8), (marker_x, marker_y + 48)], fill=pin)
    draw.ellipse((marker_x - 11, marker_y - 35, marker_x + 11, marker_y - 13), fill=pin_inner)
    draw.ellipse((marker_x - 5, marker_y - 29, marker_x + 5, marker_y - 19), fill=pin_core)

    draw.rounded_rectangle((1, 1, WIDTH - 2, HEIGHT - 2), radius=22, outline="#dcdcdc", width=2)

    image.convert("RGB").save(OUTPUT, quality=95)


if __name__ == "__main__":
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    draw_map()
