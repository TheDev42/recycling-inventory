from barcode import Code128

QUIET_ZONE = 10  # modules of white space either side, required for reliable scanning


def barcode_svg(value):
    """Code 128 barcode as an inline SVG that stretches to fill its container."""
    modules = Code128(value).build()[0]
    rects = []
    i = 0
    while i < len(modules):
        if modules[i] == "1":
            j = i
            while j < len(modules) and modules[j] == "1":
                j += 1
            rects.append(f'<rect x="{i + QUIET_ZONE}" y="0" width="{j - i}" height="10"/>')
            i = j
        else:
            i += 1
    width = len(modules) + 2 * QUIET_ZONE
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} 10" '
        f'preserveAspectRatio="none" shape-rendering="crispEdges" fill="#000">'
        f'{"".join(rects)}</svg>'
    )
