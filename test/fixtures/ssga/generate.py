#!/usr/bin/env python3
# Provenance for the SSGA holdings test fixtures. These are SYNTHETIC files that mirror the documented layout of
# SSGA's SPDR "holdings-daily-us-en-<etf>.xlsx" download (preamble rows, then a Name/Ticker/Weight header, then
# constituents). The real live layout is CR-verified against an actual file on first ingest. Regenerate with:
#   pip install openpyxl && python3 test/fixtures/ssga/generate.py
import openpyxl

def book(rows):
    wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Holdings"
    for r in rows: ws.append(r)
    return wb

HEADER = ["Name", "Ticker", "Identifier", "SEDOL", "Weight", "Sector", "Shares Held", "Local Currency"]

# A realistic XLI file: preamble, blank row, header, constituents (weights are PERCENT of NAV, summing ~99 with a
# small cash line the decoder skips). Column order is deliberately as SSGA ships it.
xli = book([
    ["Fund Name:", "The Industrial Select Sector SPDR Fund"],
    ["Ticker Symbol:", "XLI"],
    ["As of Date:", "08/29/2026"],
    ["Holdings are subject to change."],
    [],
    HEADER,
    ["GE Aerospace", "GE", "369604301", "2380498", "20.00", "Industrials", "1234567", "USD"],
    ["Caterpillar Inc.", "CAT", "149123101", "2180201", "18.00", "Industrials", "456789", "USD"],
    ["RTX Corporation", "RTX", "75513E101", "2153360", "17.00", "Industrials", "345678", "USD"],
    ["Union Pacific", "UNP", "907818108", "2916090", "16.00", "Industrials", "234567", "USD"],
    ["Honeywell International", "HON", "438516106", "2020459", "15.00", "Industrials", "212345", "USD"],
    ["Deere & Company", "DE", "244199105", "2261700", "13.00", "Industrials", "123456", "USD"],
    ["US DOLLAR", "-", "-", "-", "", "Cash", "1000000", "USD"],
])
xli.save("test/fixtures/ssga/holdings-xli.xlsx")

# Wrong fund: the preamble ticker is XLP, so decoding it as XLI must fail closed (mis-fetched file guard).
wrong = book([
    ["Fund Name:", "The Consumer Staples Select Sector SPDR Fund"],
    ["Ticker Symbol:", "XLP"],
    ["As of Date:", "08/29/2026"],
    [],
    HEADER,
    ["Procter & Gamble", "PG", "742718109", "2704407", "99.00", "Consumer Staples", "1", "USD"],
])
wrong.save("test/fixtures/ssga/holdings-wrongfund.xlsx")

# No recognizable header row -> fail closed.
noheader = book([
    ["Fund Name:", "The Industrial Select Sector SPDR Fund"],
    ["Ticker Symbol:", "XLI"],
    ["As of Date:", "08/29/2026"],
    ["Some", "unlabeled", "columns", "here"],
    ["GE Aerospace", "GE", "20.00"],
])
noheader.save("test/fixtures/ssga/holdings-noheader.xlsx")

# Weights that do not sum near 100% (a misread column / scaling change) -> fail closed.
badsum = book([
    ["Fund Name:", "The Industrial Select Sector SPDR Fund"],
    ["Ticker Symbol:", "XLI"],
    ["As of Date:", "08/29/2026"],
    [],
    HEADER,
    ["GE Aerospace", "GE", "369604301", "2380498", "3.00", "Industrials", "1", "USD"],
    ["Caterpillar Inc.", "CAT", "149123101", "2180201", "2.00", "Industrials", "1", "USD"],
])
badsum.save("test/fixtures/ssga/holdings-badsum.xlsx")

# A real constituent (valid ticker) with a blank Weight cell -> the whole file must fail closed, because a
# silently dropped issuer could be a restricted one and let the ETF fail-open through compliance.
blankweight = book([
    ["Fund Name:", "The Industrial Select Sector SPDR Fund"],
    ["Ticker Symbol:", "XLI"],
    ["As of Date:", "08/29/2026"],
    [],
    HEADER,
    ["GE Aerospace", "GE", "369604301", "2380498", "", "Industrials", "1", "USD"],
    ["Caterpillar Inc.", "CAT", "149123101", "2180201", "60.00", "Industrials", "1", "USD"],
])
blankweight.save("test/fixtures/ssga/holdings-blankweight.xlsx")

print("wrote holdings-xli / holdings-wrongfund / holdings-noheader / holdings-badsum / holdings-blankweight .xlsx")
