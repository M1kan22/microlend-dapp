"""Generate the MicroLend diagrams in docs/images/.

Run:  python docs/images/gen_diagrams.py

These are *programmatically drawn* architecture / measurement figures. They are NOT screenshots.
Every number in money-invariant.png comes from the ganache runs recorded in docs/TESTING.md.
"""

import math
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))

BOLD = r"C:\Windows\Fonts\segoeuib.ttf"
REG = r"C:\Windows\Fonts\segoeui.ttf"
MONO = r"C:\Windows\Fonts\consola.ttf"


def F(sz, bold=False):
    return ImageFont.truetype(BOLD if bold else REG, sz)


def M(sz):
    return ImageFont.truetype(MONO, sz)


BG = (246, 247, 250)
INK = (24, 28, 36)
MUTED = (92, 102, 116)
BLUE = (31, 86, 168)
BLUE_F = (228, 238, 250)
GREEN = (21, 115, 80)
GREEN_F = (224, 243, 235)
AMBER = (168, 105, 10)
AMBER_F = (252, 241, 220)
PURPLE = (92, 53, 177)
PURPLE_F = (236, 231, 248)
GREY = (122, 132, 146)
GREY_F = (238, 240, 245)
RED = (170, 40, 40)


def box(d, x0, y0, x1, y1, fill, outline, w=2, r=14):
    d.rounded_rectangle([x0, y0, x1, y1], radius=r, fill=fill, outline=outline, width=w)


def txt(d, x, y, s, font, fill=INK, anchor="la"):
    d.text((x, y), s, font=font, fill=fill, anchor=anchor)


def arrow(d, x0, y0, x1, y1, color=GREY, w=3, head=13):
    d.line([x0, y0, x1, y1], fill=color, width=w)
    a = math.atan2(y1 - y0, x1 - x0)
    p1 = (x1 - head * math.cos(a - 0.42), y1 - head * math.sin(a - 0.42))
    p2 = (x1 - head * math.cos(a + 0.42), y1 - head * math.sin(a + 0.42))
    d.polygon([(x1, y1), p1, p2], fill=color)


# ---------------------------------------------------------------------------
# 1. architecture.png
# ---------------------------------------------------------------------------

def architecture():
    W, H = 1680, 1130
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    txt(d, 40, 26, "MicroLend \u2014 system architecture", F(31, True))
    txt(d, 40, 66, "SC6113 Individual Assignment  \u00b7  Ethereum Sepolia (chainId 11155111)  \u00b7  no private key ever reaches the browser or the backend", F(16), MUTED)

    box(d, 40, 116, 1020, 478, GREY_F, GREY)
    txt(d, 62, 132, "BROWSER \u2014 HTML + CSS + vanilla JS, zero build step", F(20, True), INK)
    txt(d, 998, 138, "window.ML_*", M(14), GREY, anchor="ra")

    box(d, 62, 176, 538, 300, (255, 255, 255), BLUE)
    txt(d, 82, 190, "index.html  +  css/styles.css", F(16, True), BLUE)
    txt(d, 82, 220, "dashboard \u00b7 deposit \u00b7 borrow \u00b7 loans", F(14), INK)
    txt(d, 82, 244, "history \u00b7 pool stats \u00b7 settings", F(14), INK)
    txt(d, 82, 268, "toasts, busy states, empty states", F(14), MUTED)

    box(d, 562, 176, 998, 300, (255, 255, 255), BLUE)
    txt(d, 582, 190, "js/config.js   js/abi.js", F(16, True), BLUE)
    txt(d, 582, 220, "ML_CONFIG  chainId/address/apiBase", F(14), INK)
    txt(d, 582, 244, "ML_CONTRACT_ABI (mirrors artifact)", F(14), INK)
    txt(d, 582, 268, "?demo=1 / ?contract= / ?api= overrides", F(14), MUTED)

    box(d, 62, 316, 538, 452, (255, 255, 255), GREEN)
    txt(d, 82, 330, "js/ui.js   js/demo.js", F(16, True), GREEN)
    txt(d, 82, 360, "ML_UI  escapeHtml/formatEth/toast", F(14), INK)
    txt(d, 82, 384, "ML_DEMO  offline protocol engine:", F(14), INK)
    txt(d, 82, 408, "same state machine, no wallet / no chain", F(14), MUTED)

    box(d, 562, 316, 998, 452, (255, 255, 255), GREEN)
    txt(d, 582, 330, "js/wallet.js  api.js  contract.js  history.js", F(16, True), GREEN)
    txt(d, 582, 360, "MetaMask adapter (window.ethereum)", F(14), INK)
    txt(d, 582, 384, "fetch client: Bearer token, JSON envelope", F(14), INK)
    txt(d, 582, 408, "tx builder + receipt wait + event history", F(14), MUTED)

    box(d, 40, 556, 430, 720, AMBER_F, AMBER)
    txt(d, 62, 570, "METAMASK  (browser extension)", F(17, True), AMBER)
    txt(d, 62, 602, "holds the private key \u00b7 signs \u00b7 broadcasts", F(14), INK)
    txt(d, 62, 626, "eth_requestAccounts", M(13), INK)
    txt(d, 62, 648, "wallet_switchEthereumChain  0xaa36a7", M(13), INK)
    txt(d, 62, 670, "personal_sign  (backend session)", M(13), INK)

    box(d, 1100, 116, 1640, 720, PURPLE_F, PURPLE)
    txt(d, 1122, 132, "FLASK BACKEND \u2014 REST /api (JSON only)", F(20, True), PURPLE)
    txt(d, 1122, 168, "app.py   routes + error envelope", M(14), INK)
    txt(d, 1122, 192, "{ok:true,data} | {ok:false,error:{code,message,fields}}", M(12), MUTED)
    txt(d, 1122, 226, "validation.py   ETH<->wei, bounds, pagination", M(14), INK)
    txt(d, 1122, 250, "auth.py   secp256k1 ecrecover + HMAC session token", M(14), INK)
    txt(d, 1122, 274, "keccak.py   pure-Python Keccak-256 (event topics)", M(14), INK)

    box(d, 1140, 312, 1600, 432, (255, 255, 255), PURPLE)
    txt(d, 1160, 326, "write path (no key material, ever)", F(15, True), PURPLE)
    txt(d, 1160, 356, "1  Bearer token address == on-chain actor", F(13), INK)
    txt(d, 1160, 378, "2  verify txHash receipt + decode event", F(13), INK)
    txt(d, 1160, 400, "3  persist the row (only then)", F(13), INK)

    box(d, 1140, 456, 1600, 600, (255, 255, 255), PURPLE)
    txt(d, 1160, 470, "read paths", F(15, True), PURPLE)
    txt(d, 1160, 500, "/api/pool /api/loans /api/positions", M(13), INK)
    txt(d, 1160, 522, "/api/transactions /api/loans/preview", M(13), INK)
    txt(d, 1160, 544, "/api/simulate  dry-run + estimate", M(13), INK)
    txt(d, 1160, 572, "CHAIN_MODE=rpc | mock (offline grading)", M(12), MUTED)

    txt(d, 1122, 632, "Never receives or stores a private key;", F(14, True), RED)
    txt(d, 1122, 656, "rejects bodies containing key material.", F(14, True), RED)
    txt(d, 1122, 684, "Amounts: ETH decimal string in, wei string stored.", F(13), MUTED)

    box(d, 1240, 776, 1620, 906, (255, 255, 255), PURPLE)
    txt(d, 1260, 790, "SQLite  backend/data/microlend.db", F(15, True), PURPLE)
    txt(d, 1260, 820, "loans \u00b7 transactions \u00b7 nonces \u00b7 sessions", F(13), INK)
    txt(d, 1260, 846, "rebuilt from chain events;", F(13), MUTED)
    txt(d, 1260, 868, "the chain is the source of truth", F(13), MUTED)

    box(d, 40, 796, 1200, 1090, BLUE_F, BLUE)
    txt(d, 62, 812, "ETHEREUM SEPOLIA  \u00b7  contracts/MicroLendPool.sol  (Solidity 0.8.24)", F(19, True), BLUE)
    box(d, 62, 856, 560, 1050, (255, 255, 255), BLUE)
    txt(d, 82, 870, "state", F(15, True), BLUE)
    for i, s in enumerate([
        "totalShares / totalLiquidity",
        "reservedLiquidity / treasuryBalance",
        "accumulatedCollateral",
        "Loan{ id, borrower, principal,",
        "   collateral, interest, rateBps,",
        "   durationDays, startTime, dueDate,",
        "   amountFunded, status }",
    ]):
        txt(d, 82, 898 + i * 22, s, M(12), INK)
    box(d, 582, 856, 1180, 1050, (255, 255, 255), BLUE)
    txt(d, 602, 870, "guarantees", F(15, True), BLUE)
    for i, s in enumerate([
        "nonReentrant + checks-effects-interactions",
        "ERC-4626-style shares, DEAD_SHARES=1 bootstrap",
        "receive()/fallback() revert: no plain donations",
        "custom errors + one event per state change",
        "owner: setParams/setPaused/claimTreasury only",
    ]):
        txt(d, 602, 898 + i * 22, s, M(12), INK)
    txt(d, 602, 1020, "suppliers can always withdraw while paused", M(12), GREEN)

    arrow(d, 235, 478, 235, 556, GREY, 3)
    txt(d, 248, 500, "window.ethereum", F(14), MUTED)
    arrow(d, 235, 720, 235, 796, GREY, 3)
    txt(d, 248, 734, "signed transaction", F(14), MUTED)
    arrow(d, 330, 796, 330, 720, GREEN, 3)
    txt(d, 344, 764, "events / receipts", F(14), GREEN)
    arrow(d, 1020, 300, 1100, 300, GREY, 3)
    txt(d, 1060, 272, "fetch JSON", F(14), MUTED, anchor="ma")
    arrow(d, 1200, 720, 1200, 796, GREY, 3)
    txt(d, 1188, 726, "eth_getTransactionReceipt", M(13), MUTED, anchor="ra")
    txt(d, 1188, 748, "eth_call / eth_getLogs", M(13), MUTED, anchor="ra")
    arrow(d, 1430, 720, 1430, 776, PURPLE, 3)
    txt(d, 1444, 738, "indexed rows", F(14), PURPLE)

    out = os.path.join(HERE, "architecture.png")
    img.save(out)
    print("wrote", out, img.size)


# ---------------------------------------------------------------------------
# 2. money-invariant.png  (values measured on a real EVM; see docs/TESTING.md)
# ---------------------------------------------------------------------------

def money_invariant():
    W, H = 1560, 900
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    txt(d, 40, 26, "Measured money identity, before and after the F-01/F-02 fix", F(29, True))
    txt(d, 40, 68, "Real ganache runs on both revisions  \u00b7  claims = totalLiquidity + accumulatedCollateral + treasuryBalance (collateral is zero in these scenarios)", F(15), MUTED)
    txt(d, 40, 92, "Amended spec \u00a72.7(12):  balance == totalLiquidity + accumulatedCollateral + treasuryBalance - reservedLiquidity", F(15), MUTED)

    # (label, contract balance, supplier claims BEFORE the fix, AFTER the fix) — all in ETH
    scen = [
        ("E1  after full repay", 1.000821917808219, 1.100821917808219, 1.000821917808219),
        ("E2  after late repay", 1.001830136986301, 1.100821917808219, 1.001830136986301),
        ("E3  liquidate (covered)", 2.006921643835616, 2.106921643835616, 2.006921643835616),
        ("E4  liquidate (bad debt)", 0.95, 1.05, 0.95),
    ]
    X0, Y0, X1, Y1 = 150, 200, 1500, 700
    ymax = 2.4

    def yv(v):
        return Y1 - (v / ymax) * (Y1 - Y0)

    for gv in [0, 0.5, 1.0, 1.5, 2.0]:
        y = yv(gv)
        d.line([X0, y, X1, y], fill=(220, 224, 232), width=1)
        txt(d, X0 - 14, y, "%.1f" % gv, F(14), MUTED, anchor="rm")
    txt(d, X0 - 14, Y0 - 24, "ETH", F(14, True), MUTED, anchor="rm")
    d.line([X0, Y1, X1, Y1], fill=GREY, width=2)

    slot = (X1 - X0) / len(scen)
    bw = 42
    for i, (name, bal, pre, post) in enumerate(scen):
        cx = X0 + slot * i + slot / 2
        d.rectangle([cx - 1.5 * bw - 4, yv(bal), cx - 0.5 * bw - 4, Y1], fill=BLUE)
        d.rectangle([cx - 0.5 * bw + 4, yv(pre), cx + 0.5 * bw + 4, Y1], fill=RED)
        d.rectangle([cx + 0.5 * bw + 12, yv(post), cx + 1.5 * bw + 12, Y1], fill=GREEN)
        txt(d, cx, Y1 + 14, name, F(15, True), INK, anchor="ma")
        txt(d, cx - bw, yv(bal) - 20, "%.4f" % bal, F(11), BLUE, anchor="ma")
        txt(d, cx, yv(pre) - 20, "%.4f" % pre, F(11), RED, anchor="ma")
        txt(d, cx + bw, yv(post) - 20, "%.4f" % post, F(11), GREEN, anchor="ma")
        txt(d, cx, 152, "pre-fix gap +%.15f ETH" % (pre - bal), F(12, True), RED, anchor="ma")
        txt(d, cx, 176, "post-fix gap 0 wei", F(12, True), GREEN, anchor="ma")

    d.rectangle([X0, 742, X0 + 24, 766], fill=BLUE)
    txt(d, X0 + 32, 744, "contract balance", F(14), INK)
    d.rectangle([X0 + 260, 742, X0 + 284, 766], fill=RED)
    txt(d, X0 + 292, 744, "claims BEFORE fix (sha a6d6ea64\u2026)", F(14), INK)
    d.rectangle([X0 + 640, 742, X0 + 664, 766], fill=GREEN)
    txt(d, X0 + 672, 744, "claims AFTER fix (sha e26e720a\u2026)", F(14), INK)

    txt(d, 40, 806, "BEFORE the fix every settlement credited disbursed principal back into totalLiquidity although _activate never debited it, so claims", F(15), INK)
    txt(d, 40, 828, "exceeded cash by exactly the principal (0.1 ETH here) and withdraw(allShares) reverted. AFTER the fix the gap is 0 wei in every state", F(15), INK)
    txt(d, 40, 850, "measured, and the sole supplier can withdraw in full. See docs/TESTING.md F-01..F-05.", F(15), INK)
    txt(d, 40, 876, "Source: docs/TESTING.md \u00a7Raw evidence \u2014 commands and full state dumps are recorded there. Values are exact wei / 1e18.", F(13), MUTED)

    out = os.path.join(HERE, "money-invariant.png")
    img.save(out)
    print("wrote", out, img.size)


if __name__ == "__main__":
    architecture()
    money_invariant()
