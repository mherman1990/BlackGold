#!/usr/bin/env python3
# Provenance for the SSGA distribution and NAV-history test fixtures (D-58). These are SYNTHETIC files that mirror
# the layout of SSGA's public workbooks as observed on 2026-10-06 - the all-funds
# "spdr-etf-historical-distributions.xlsx" and the per-fund "navhist-us-en-<etf>.xlsx" - with made-up values. No
# SSGA data is reproduced. Regenerate with:
#   pip install openpyxl && python3 test/fixtures/ssga/generate-distributions.py
import openpyxl

OUT = "test/fixtures/ssga/"


def book(rows, title):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = title
    for r in rows:
        ws.append(r)
    return wb


DIST_HEADER = ["FUND NAME", "TICKER", "CUSIP", "EX-DATE", "RECORD DATE", "PAYABLE DATE", "DIVIDEND ($)",
               "SHORT TERM CAPITAL GAIN ($)", "LONG TERM CAPITAL GAIN ($)", "FREQUENCY"]
DISCLAIMER = [["Dividend distributions are the net income from dividends and interest earned by fund securities."], [],
              ["Exp. 04/30/2027"]]


def fund(name, ticker, ex, rec, pay, div, st=None, lt=None, freq="Quarterly"):
    return [name, ticker, "000000000", ex, rec, pay, div, st, lt, freq]


TECH = "Synthetic Technology Select Sector Fund"
FIN = "Synthetic Financial Select Sector Fund"
BILL = "Synthetic 1-3 Month T-Bill Fund"
SP = "Synthetic S&P 500 Trust"

# Newest first, as SSGA ships it. Amounts and dates are TEXT, as in the live file.
distributions = book([DIST_HEADER,
    fund(TECH, "XLK", "12/24/2018", "12/26/2018", "12/31/2018", "0.234213"),
    fund(TECH, "XLK", "09/24/2018", "09/25/2018", "09/28/2018", "0.198100"),
    fund(TECH, "XLK", "03/16/2007", "03/20/2007", "03/23/2007", "0.000000"),        # nothing paid: not a record
    fund(FIN, "XLF", "09/19/2016", "09/21/2016", "09/22/2016", "0.139146"),         # the spin-off ratio in the $ column
    fund(FIN, "XLF", "09/16/2016", "09/20/2016", "09/26/2016", "0.114386"),
    fund(SP, "SPY", "12/21/2018", "12/24/2018", "01/31/2019", "1.435100", "0.010000", "0.002500", "Quarterly"),
    fund(BILL, "BIL", "03/03/2008", "02/05/2008", "02/11/2008", "0.086739", freq="Monthly"),  # pay date precedes ex
    fund(BILL, "BIL", "02/01/2008", "02/05/2008", "02/11/2008", "0.115251", freq="Monthly"),
    fund(BILL, "BIL", "12/01/2009", "12/03/2009", "12/08/2009", "0.000000", freq="Monthly"),
    # Another fund with an unreadable ex-date: must not matter unless asked for.
    fund("Synthetic Other Fund", "ZZZ", "not a date", "", "", "oops"),
    [], *DISCLAIMER], "dividend")
distributions.save(OUT + "distributions.xlsx")

book([DIST_HEADER, fund(TECH, "XLK", "2018/12/24", "", "", "0.2")], "dividend").save(OUT + "distributions-baddate.xlsx")
book([DIST_HEADER, fund(TECH, "XLK", "12/24/2018", "", "", "0.2"), fund(TECH, "XLK", "12/24/2018", "", "", "0.05")],
     "dividend").save(OUT + "distributions-dup.xlsx")
book([DIST_HEADER, fund(TECH, "XLK", "12/24/2018", "", "", "-0.2")], "dividend").save(OUT + "distributions-negative.xlsx")
book([["TICKER", "EX-DATE", "AMOUNT"], ["XLK", "12/24/2018", "0.2"]], "dividend").save(OUT + "distributions-noheader.xlsx")

NAV_HEADER = ["Date", "NAV", "Shares Outstanding", "Total Net Assets"]


def nav_book(ticker, rows):
    return book([["Fund Name:", "Synthetic Fund"], ["Ticker Symbol:", ticker], [], NAV_HEADER, *rows, [],
                 ["Before investing in a fund, consider its investment objectives."]], "navhist")


# Newest first. Numbers are numbers; early share counts are "-" (unpublished), as in the live file. Levels run on
# continuously between the events, so each event below is the only big one-day move in its pair of rows.
navhist = nav_book("XLK", [
    ["03-Dec-2025", 7.50, 200000000, 1500000000],
    ["02-Dec-2025", 7.30, 196000000, 1430800000],    # 2-for-1: NAV x0.503 (with the day's move), shares x2.0 -> SPLIT 2
    ["01-Dec-2025", 14.50, 98000000, 1421000000],
    ["01-Dec-2017", 14.40, 98000000, 1411200000],    # 1-for-2 reverse: NAV x2.0, shares x0.5 -> SPLIT 0.5
    ["30-Nov-2017", 7.20, 196000000, 1411200000],
    ["10-Oct-2008", 7.00, 300000000, 2100000000],    # -30% with shares flat: a jump, never a split
    ["09-Oct-2008", 10.00, 300000000, 3000000000],
    ["08-Oct-2008", 10.05, 300000000, 3015000000],
    ["05-Jan-2007", 10.00, 280000000, 2800000000],   # NAV halves, shares only +30%: no ratio fits both, a jump
    ["04-Jan-2007", 20.00, 215000000, 4300000000],
    ["30-May-2006", 20.35, "-", "-"],                # shares unpublished: a halving NAV is a jump, not a split
    ["26-May-2006", 40.77, "-", "-"],
    ["25-May-2006", 40.65, "-", "-"],
])
navhist.save(OUT + "navhist-xlk.xlsx")
nav_book("XLF", [["02-Dec-2025", 50.0, 100, 5000]]).save(OUT + "navhist-wrongfund.xlsx")
# Two months missing between rows that happen to fit a 2-for-1 exactly: a gap, never a split.
nav_book("XLK", [
    ["04-Mar-2019", 10.05, 200000000, 2010000000],
    ["01-Mar-2019", 10.00, 200000000, 2000000000],   # NAV x0.5 and shares x2 since 02-Jan, with 39 sessions unlisted
    ["02-Jan-2019", 20.00, 100000000, 2000000000],
    ["31-Dec-2018", 20.10, 100000000, 2010000000],
]).save(OUT + "navhist-gap.xlsx")
# A Saturday-dated row between Friday and Monday: no session is skipped, but Saturday is not a session, so the
# Friday-to-Saturday halving is a jump, never a split.
nav_book("XLK", [
    ["07-Jan-2019", 10.05, 200000000, 2010000000],
    ["05-Jan-2019", 10.00, 200000000, 2000000000],
    ["04-Jan-2019", 20.00, 100000000, 2000000000],
]).save(OUT + "navhist-weekend.xlsx")
book([NAV_HEADER, ["02-Dec-2025", 50.0, 100, 5000]], "navhist").save(OUT + "navhist-noticker.xlsx")
nav_book("XLK", [["02-Dec-2025", 50.0, 100, 5000], ["02-Dec-2025", 51.0, 100, 5100]]).save(OUT + "navhist-dupdate.xlsx")
nav_book("XLK", [["02-Dec-2025", "n/a", 100, 5000]]).save(OUT + "navhist-badnav.xlsx")

# Quiet NAV histories for the other funds in distributions.xlsx, so a full reconcile run has one per fund.
for t in ["XLF", "SPY", "BIL"]:
    nav_book(t, [["03-Dec-2025", 50.10, 1000000, 50100000], ["02-Dec-2025", 50.00, 1000000, 50000000]]).save(OUT + f"navhist-{t.lower()}.xlsx")

print("wrote distributions*.xlsx and navhist-*.xlsx")
