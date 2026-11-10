"""
Reiner Offline-QR-Code-Generator (ISO/IEC 18004) als SVG.
Benötigt keinerlei externe Pakete oder Internetverbindung.
Unterstützt Byte-Mode (UTF-8) für URLs bis 192 Zeichen (Version 1-L bis 8-L).
"""

# (version, total_codewords, data_codewords_L, ec_codewords_per_block, num_blocks, alignment_centers)
_VERSION_TABLE_L = [
    (1, 26, 19, 7, 1, []),
    (2, 44, 34, 10, 1, [6, 18]),
    (3, 70, 55, 15, 1, [6, 22]),
    (4, 100, 80, 20, 1, [6, 26]),
    (5, 134, 108, 26, 1, [6, 30]),
    (6, 172, 136, 18, 2, [6, 34]),
    (7, 196, 156, 20, 2, [6, 22, 38]),
    (8, 242, 194, 24, 2, [6, 24, 42]),
]

# GF(256) Tabellen mit primitivem Polynom 0x11D
_GF_EXP = [0] * 512
_GF_LOG = [0] * 256


def _init_gf():
    x = 1
    for i in range(255):
        _GF_EXP[i] = x
        _GF_LOG[x] = i
        x <<= 1
        if x & 0x100:
            x ^= 0x11D
    for i in range(255, 512):
        _GF_EXP[i] = _GF_EXP[i - 255]


_init_gf()


def _gf_mul(a: int, b: int) -> int:
    if a == 0 or b == 0:
        return 0
    return _GF_EXP[_GF_LOG[a] + _GF_LOG[b]]


def _rs_generator_poly(degree: int) -> list[int]:
    poly = [1]
    for i in range(degree):
        next_poly = [0] * (len(poly) + 1)
        root = _GF_EXP[i]
        for j, coeff in enumerate(poly):
            next_poly[j] ^= coeff
            next_poly[j + 1] ^= _gf_mul(coeff, root)
        poly = next_poly
    return poly


def _rs_compute_ec(data: list[int], ec_len: int) -> list[int]:
    gen = _rs_generator_poly(ec_len)
    rem = [0] * ec_len
    for byte in data:
        factor = byte ^ rem[0]
        rem = rem[1:] + [0]
        if factor != 0:
            for i in range(ec_len):
                rem[i] ^= _gf_mul(gen[i + 1], factor)
    return rem


def _encode_data_codewords(payload: bytes) -> tuple[int, list[int], list[int]]:
    length = len(payload)
    selected = None
    for entry in _VERSION_TABLE_L:
        ver, _tot, data_cw, _ec, _blk, _align = entry
        # 4 Bit Mode + 8 Bit Length = 12 Bit = 1.5 Bytes -> max (data_cw - 2) Bytes
        if length <= data_cw - 2:
            selected = entry
            break
    if selected is None:
        raise ValueError("Text zu lang für QR Version 1-8 (max. 192 Bytes)")

    ver, _tot, data_cw, ec_per_block, num_blocks, align_centers = selected

    bits: list[int] = []

    def append_bits(val: int, bit_len: int):
        for i in range(bit_len - 1, -1, -1):
            bits.append((val >> i) & 1)

    # Byte Mode (0100) + 8-Bit Länge
    append_bits(0b0100, 4)
    append_bits(length, 8)
    for b in payload:
        append_bits(b, 8)

    capacity_bits = data_cw * 8
    terminator_len = min(4, capacity_bits - len(bits))
    bits.extend([0] * terminator_len)

    while len(bits) % 8 != 0:
        bits.append(0)

    codewords: list[int] = []
    for i in range(0, len(bits), 8):
        val = 0
        for bit in bits[i : i + 8]:
            val = (val << 1) | bit
        codewords.append(val)

    pad_bytes = [0xEC, 0x11]
    pad_idx = 0
    while len(codewords) < data_cw:
        codewords.append(pad_bytes[pad_idx % 2])
        pad_idx += 1

    # In Blöcke aufteilen und Reed-Solomon Fehlerkorrektur anhängen
    block_size = data_cw // num_blocks
    data_blocks: list[list[int]] = []
    ec_blocks: list[list[int]] = []
    for b_idx in range(num_blocks):
        blk = codewords[b_idx * block_size : (b_idx + 1) * block_size]
        data_blocks.append(blk)
        ec_blocks.append(_rs_compute_ec(blk, ec_per_block))

    final_codewords: list[int] = []
    for col in range(block_size):
        for b_idx in range(num_blocks):
            final_codewords.append(data_blocks[b_idx][col])
    for col in range(ec_per_block):
        for b_idx in range(num_blocks):
            final_codewords.append(ec_blocks[b_idx][col])

    return ver, final_codewords, align_centers


def _format_bits(ec_level_bits: int, mask: int) -> int:
    data = (ec_level_bits << 3) | mask
    rem = data << 10
    for i in range(14, 9, -1):
        if (rem >> i) & 1:
            rem ^= 0x537 << (i - 10)
    return ((data << 10) | rem) ^ 0x5412


def _version_bits(version: int) -> int:
    rem = version << 12
    for i in range(17, 11, -1):
        if (rem >> i) & 1:
            rem ^= 0x1F25 << (i - 12)
    return (version << 12) | rem


def _mask_cond(mask: int, r: int, c: int) -> bool:
    if mask == 0:
        return (r + c) % 2 == 0
    if mask == 1:
        return r % 2 == 0
    if mask == 2:
        return c % 3 == 0
    if mask == 3:
        return (r + c) % 3 == 0
    if mask == 4:
        return (r // 2 + c // 3) % 2 == 0
    if mask == 5:
        return (r * c) % 2 + (r * c) % 3 == 0
    if mask == 6:
        return ((r * c) % 2 + (r * c) % 3) % 2 == 0
    return ((r + c) % 2 + (r * c) % 3) % 2 == 0


def _penalty_score(mat: list[list[int]]) -> int:
    n = len(mat)
    score = 0
    # Regel 1: >=5 gleiche Module in Folge
    for r in range(n):
        run_len = 1
        for c in range(1, n):
            if mat[r][c] == mat[r][c - 1]:
                run_len += 1
            else:
                if run_len >= 5:
                    score += 3 + (run_len - 5)
                run_len = 1
        if run_len >= 5:
            score += 3 + (run_len - 5)

    for c in range(n):
        run_len = 1
        for r in range(1, n):
            if mat[r][c] == mat[r - 1][c]:
                run_len += 1
            else:
                if run_len >= 5:
                    score += 3 + (run_len - 5)
                run_len = 1
        if run_len >= 5:
            score += 3 + (run_len - 5)

    # Regel 2: 2x2 Blöcke
    for r in range(n - 1):
        for c in range(n - 1):
            v = mat[r][c]
            if v == mat[r][c + 1] == mat[r + 1][c] == mat[r + 1][c + 1]:
                score += 3

    return score


def generate_qr_matrix(text: str) -> list[list[int]]:
    payload = text.encode("utf-8")
    ver, codewords, align_centers = _encode_data_codewords(payload)
    n = ver * 4 + 17

    matrix = [[0] * n for _ in range(n)]
    is_func = [[False] * n for _ in range(n)]

    def set_func(r: int, c: int, val: int):
        if 0 <= r < n and 0 <= c < n:
            matrix[r][c] = val
            is_func[r][c] = True

    def place_finder(top: int, left: int):
        for dr in range(-1, 8):
            for dc in range(-1, 8):
                r, c = top + dr, left + dc
                if 0 <= r < n and 0 <= c < n:
                    if 0 <= dr <= 6 and 0 <= dc <= 6:
                        on_border = dr in (0, 6) or dc in (0, 6)
                        in_center = 2 <= dr <= 4 and 2 <= dc <= 4
                        set_func(r, c, 1 if (on_border or in_center) else 0)
                    else:
                        set_func(r, c, 0)

    place_finder(0, 0)
    place_finder(0, n - 7)
    place_finder(n - 7, 0)

    # Timing Patterns
    for i in range(8, n - 8):
        val = 1 if i % 2 == 0 else 0
        set_func(6, i, val)
        set_func(i, 6, val)

    # Alignment Patterns
    for ar in align_centers:
        for ac in align_centers:
            if (ar == 6 and ac == 6) or (ar == 6 and ac == n - 7) or (ar == n - 7 and ac == 6):
                continue
            for dr in range(-2, 3):
                for dc in range(-2, 3):
                    dist = max(abs(dr), abs(dc))
                    set_func(ar + dr, ac + dc, 1 if dist in (0, 2) else 0)

    # Dark Module + Format Info Reservierung
    set_func(n - 8, 8, 1)
    for i in range(9):
        if not is_func[8][i]:
            set_func(8, i, 0)
        if not is_func[i][8]:
            set_func(i, 8, 0)
    for i in range(8):
        set_func(8, n - 1 - i, 0)
    for i in range(7):
        set_func(n - 1 - i, 8, 0)

    # Version Info ab Version 7
    if ver >= 7:
        vbits = _version_bits(ver)
        for i in range(18):
            bit = (vbits >> i) & 1
            set_func(n - 11 + (i % 3), i // 3, bit)
            set_func(i // 3, n - 11 + (i % 3), bit)

    # Datenbits in Zig-Zag eintragen
    data_bits: list[int] = []
    for cw in codewords:
        for b in range(7, -1, -1):
            data_bits.append((cw >> b) & 1)

    bit_idx = 0
    upward = True
    col = n - 1
    while col > 0:
        if col == 6:
            col -= 1
        row_iter = range(n - 1, -1, -1) if upward else range(n)
        for r in row_iter:
            for dc in (0, -1):
                c = col + dc
                if not is_func[r][c]:
                    val = data_bits[bit_idx] if bit_idx < len(data_bits) else 0
                    matrix[r][c] = val
                    bit_idx += 1
        upward = not upward
        col -= 2

    def write_format_bits(target_mat: list[list[int]], mask_id: int):
        # Level L = 0b01
        fbits = _format_bits(0b01, mask_id)
        tl_coords = [
            (0, 8), (1, 8), (2, 8), (3, 8), (4, 8), (5, 8), (7, 8), (8, 8),
            (8, 7), (8, 5), (8, 4), (8, 3), (8, 2), (8, 1), (8, 0),
        ]
        for i, (r, c) in enumerate(tl_coords):
            target_mat[r][c] = (fbits >> i) & 1

        for i in range(8):
            target_mat[8][n - 1 - i] = (fbits >> i) & 1
        for i in range(8, 15):
            target_mat[n - 15 + i][8] = (fbits >> i) & 1

    best_mat = None
    best_score = 10**9
    for mask_id in range(8):
        cand = [row[:] for row in matrix]
        for r in range(n):
            for c in range(n):
                if not is_func[r][c] and _mask_cond(mask_id, r, c):
                    cand[r][c] ^= 1
        write_format_bits(cand, mask_id)
        sc = _penalty_score(cand)
        if sc < best_score:
            best_score = sc
            best_mat = cand

    return best_mat  # type: ignore


def generate_qr_svg(text: str, border: int = 3) -> str:
    mat = generate_qr_matrix(text)
    n = len(mat)
    total = n + border * 2
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {total} {total}" shape-rendering="crispEdges">',
        f'<rect width="{total}" height="{total}" fill="#ffffff" rx="1.5" />',
        '<path fill="#0b0f19" d="',
    ]
    path_cmds = []
    for r in range(n):
        for c in range(n):
            if mat[r][c]:
                path_cmds.append(f"M{c + border},{r + border}h1v1h-1z")
    parts.append("".join(path_cmds))
    parts.append('"/></svg>')
    return "".join(parts)
