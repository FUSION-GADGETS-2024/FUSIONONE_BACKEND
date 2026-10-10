You are GLM 5.3 operating as a principal software architect, senior full-stack engineer, business reporting specialist, Excel workbook designer, PostgreSQL engineer, and QA specialist.

&nbsp;

Your task is to FULLY REIMPLEMENT the FUSION ONE REPORTS SYSTEM according to every requirement in this prompt and the reporting decisions already established in the project context.

&nbsp;

This is an implementation task.

&nbsp;

You must inspect the existing codebase, refactor the existing implementation where necessary, implement the complete reporting system, generate real Excel workbooks, populate controlled TEST data, verify business calculations, visually inspect the generated workbooks, correct defects, and run regression tests.

&nbsp;

Do not merely propose an implementation.

&nbsp;

Do not stop after creating the UI.

&nbsp;

Do not stop after generating an XLSX file.

&nbsp;

Do not declare completion until the actual reports have been generated and verified.

&nbsp;

\============================================================

1\. ABSOLUTE LANGUAGE REQUIREMENT

\============================================================

&nbsp;

ENGLISH ONLY.

&nbsp;

You MUST NOT generate Chinese anywhere in anything you create for this task.

&nbsp;

This restriction applies to:

\- implementation reports

\- newly written source comments

\- newly written documentation

\- UI labels

\- report titles

\- Excel worksheet names

\- Excel headers

\- generated workbook content

\- test descriptions

\- test output written by your implementation

\- error messages

\- logs

\- commit messages

&nbsp;

Everything newly created for this task must use English.

&nbsp;

Do not switch languages.

&nbsp;

\============================================================

2\. ABSOLUTE DATABASE SAFETY REQUIREMENT

\============================================================

&nbsp;

USE TEST SUPABASE ONLY.

&nbsp;

Production Supabase is strictly prohibited.

&nbsp;

You MUST NOT:

\- connect to production Supabase

\- query production Supabase

\- inspect production data

\- run production migrations

\- modify production records

\- create production records

\- delete production records

\- use production service-role credentials

\- run production SQL

\- reset production

\- use a production database URL for testing

&nbsp;

Before any database operation, verify that the active project is the intended TEST project.

&nbsp;

Do not assume the environment is correct merely because a variable contains the word TEST.

&nbsp;

Verify the project identity using the repository's established configuration and available project metadata.

&nbsp;

If you cannot confidently identify the TEST project, stop database operations until the environment is resolved.

&nbsp;

Inspect the existing TEST data before adding fixtures.

&nbsp;

Preserve unrelated TEST data.

&nbsp;

Do not reset the entire TEST database to make testing convenient.

&nbsp;

Production must remain untouched.

&nbsp;

\============================================================

3\. AUTHORITATIVE PROJECT CONTEXT

\============================================================

&nbsp;

Read CURRENT\_SYSTEM\_SUMMARY completely before implementation.

&nbsp;

Inspect the actual repository and current source code.

&nbsp;

The source code is the implementation truth.

&nbsp;

Use the system summary to understand existing architecture, decisions, completed work, and constraints.

&nbsp;

Reconcile any differences between the summary and the current implementation before changing code.

&nbsp;

Inspect the existing:

\- Analytics module

\- Reports page

\- Excel generation code

\- report download flow

\- business queries

\- sales and invoice models

\- invoice-to-inventory relationships

\- purchase and payment models

\- parties and balances

\- inventory valuation

\- trade-in lifecycle

\- proforma lifecycle

\- financial-year implementation

\- store configuration

\- store branding assets

\- existing filters

\- backend conventions

\- frontend UI conventions

\- tests and test data

\- existing Excel dependencies

&nbsp;

Do not rebuild unrelated completed functionality.

&nbsp;

Do not assume previous implementation reports prove that the current code is correct.

&nbsp;

Verify the current implementation directly.

&nbsp;

\============================================================

4\. CORE OBJECTIVE

\============================================================

&nbsp;

Reimplement the Reports experience as a proper business reporting system.

&nbsp;

The current Excel output looks like objects placed randomly.

&nbsp;

That approach must be replaced.

&nbsp;

We are NOT trying to make a spreadsheet look like a web dashboard.

&nbsp;

We are building professional business reports similar in usability and structure to reports produced by established billing and accounting software.

&nbsp;

The final system must provide:

&nbsp;

1\. A useful Reports catalogue.

2\. Individual Excel exports.

3\. A consolidated report workbook.

4\. A consistent, reusable report-generation architecture.

5\. Proper store branding.

6\. Accurate business data.

7\. Correct totals and date semantics.

8\. Professional worksheet layouts.

9\. Excel-native filtering and formatting.

10\. Thorough numerical and visual verification.

&nbsp;

A dashboard is NOT mandatory.

&nbsp;

Individual business reports are the primary deliverable.

&nbsp;

\============================================================

5\. NON-NEGOTIABLE ARCHITECTURAL REQUIREMENTS

\============================================================

&nbsp;

Do not append another reporting layer to the existing system without examining the architecture.

&nbsp;

Inspect the existing exporter and refactor it properly.

&nbsp;

The target architecture is:

&nbsp;

Existing FUSION ONE Business Domains

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;|

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;v

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Authoritative Business Queries

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;|

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;v

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Normalized Report Data

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;|

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;v

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Report Definitions

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;|

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;v

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Shared Excel Renderer

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;|

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;\+-------+--------+

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;|                |

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;v                v

&nbsp;&nbsp;Individual Exports  Complete Report Pack

&nbsp;

Implement this architecture in a manner consistent with the existing frontend/backend boundaries.

&nbsp;

Requirements:

&nbsp;

\- One coherent report-generation architecture.

\- Shared formatting and worksheet layout logic.

\- Shared authoritative business queries wherever appropriate.

\- Reusable report definitions.

\- Individual exports and consolidated exports use the same report definitions.

\- No independent competing business calculations.

\- No duplicate Excel exporters with overlapping responsibilities.

\- No unnecessary dependencies.

\- No analytics warehouse.

\- No unnecessary report database.

\- No speculative caching.

\- No unnecessary Redis infrastructure.

\- No hardcoded business values.

\- No mock report data in production code.

\- No duplicate compatibility layers.

\- No unfinished code.

\- No TODOs for required functionality.

\- No placeholder reports.

\- No fake report metrics.

&nbsp;

Refactor existing code when needed to establish a correct architecture.

&nbsp;

Preserve existing functionality and existing business contracts unless a deliberate, justified refactor requires updating them.

&nbsp;

Remove obsolete paths after the new architecture is working.

&nbsp;

\============================================================

6\. STORE BRANDING — CRITICAL REQUIREMENT

\============================================================

&nbsp;

The reports represent the STORE, not the software vendor.

&nbsp;

FUSION ONE is the application.

&nbsp;

The configured store is the business issuing the report.

&nbsp;

The primary report heading MUST use the actual store name from the existing authoritative store configuration.

&nbsp;

Example:

&nbsp;

ABC MOBILE STORE

&nbsp;

Sales Register

&nbsp;

The example name is illustrative only.

&nbsp;

Never hardcode it.

&nbsp;

Do not use FUSION ONE as the business heading or primary report branding.

&nbsp;

Inspect how the application stores:

\- store name

\- store logo

\- address

\- phone number

\- other relevant business information

&nbsp;

Use only fields that actually exist and are appropriate for business reporting.

&nbsp;

If a configured logo exists and can be retrieved reliably, it may be used where appropriate.

&nbsp;

Do not invent missing store details.

&nbsp;

Do not create a second store configuration system.

&nbsp;

Do not introduce GST fields.

&nbsp;

The store name must be consistent across:

\- individual report workbooks

\- consolidated report workbooks

\- worksheet headings

\- report metadata where appropriate

\- generated filenames

&nbsp;

Use a sanitized filename derived from the store name.

&nbsp;

Example:

&nbsp;

ABC-MOBILE-STORE-Sales-Register-FY-2026-27.xlsx

&nbsp;

If the store name is missing, handle the missing configuration cleanly. Do not silently substitute a fictional business name.

&nbsp;

\============================================================

7\. ABSOLUTE QUANTITY RESTRICTION

\============================================================

&nbsp;

FUSION ONE DOES NOT HAVE A QUANTITY FIELD FOR THIS REPORTING REQUIREMENT.

&nbsp;

DO NOT INVENT ONE.

&nbsp;

DO NOT introduce quantity fields or quantity-based metrics into the Reports system.

&nbsp;

Specifically, do not add:

\- Quantity

\- Units Sold

\- Available Quantity

\- Total Quantity Sold

\- Stock Quantity

\- Quantity-Based Inventory KPIs

&nbsp;

Do not create database columns solely to satisfy conventional billing-report expectations.

&nbsp;

Do not infer that every inventory record has a quantity field.

&nbsp;

The report system must reflect the actual FUSION ONE data model.

&nbsp;

Individual inventory records may be listed individually, with their supported attributes.

&nbsp;

If a count of inventory records is useful and correctly defined, it may be reported as a RECORD COUNT. Do not misrepresent it as a quantity field.

&nbsp;

If an existing source has a genuine, semantically valid count that is already part of the business model, inspect its meaning before deciding whether it belongs in a report.

&nbsp;

The default rule is that quantity fields and quantity metrics are excluded.

&nbsp;

\============================================================

8\. REPORT CATALOGUE

\============================================================

&nbsp;

Implement the Reports experience inside the existing Analytics \> Reports section.

&nbsp;

Do not add a new primary Analytics tab.

&nbsp;

Do not add a nested permanent sidebar.

&nbsp;

The existing Analytics primary sections remain:

&nbsp;

\- Overview

\- Sales

\- Money

\- Inventory

\- Reports

&nbsp;

The Reports section should provide a clear catalogue of useful business reports.

&nbsp;

Implement the following reports where the existing data model supports them reliably.

&nbsp;

A. SALES REPORTS

&nbsp;

1\. Sales Register

2\. Sales Summary

3\. Item-wise Sales Report, using supported item and product information without quantity metrics

&nbsp;

B. PURCHASE AND PAYMENT REPORTS

&nbsp;

4\. Purchase Register

5\. Purchase Summary

6\. Payments Register

&nbsp;

C. OUTSTANDING AND PARTY REPORTS

&nbsp;

7\. Customer Outstanding Report

8\. Receivables Ageing Report

9\. Supplier Payables Report

10\. Party Statement, if supported by the existing transaction model

&nbsp;

D. INVENTORY REPORTS

&nbsp;

11\. Inventory Register

12\. Inventory Valuation Report

13\. Inventory Ageing Report

&nbsp;

E. FUSION ONE-SPECIFIC REPORTS

&nbsp;

14\. Trade-In Register

15\. Proforma Register

&nbsp;

16\. Day Book / Transaction Register ONLY if the existing data model can produce a reliable chronological transaction report.

&nbsp;

Do not fabricate a unified accounting ledger.

&nbsp;

Do not create reports that imply accounting capabilities the application does not have.

&nbsp;

If a proposed report cannot be implemented accurately using the existing model, investigate whether an appropriate authoritative query can be constructed.

&nbsp;

If the underlying data genuinely cannot support it, document the limitation instead of generating misleading output.

&nbsp;

Do not silently omit a required report without explaining the reason.

&nbsp;

\============================================================

9\. INDIVIDUAL EXPORTS ARE THE PRIMARY EXPERIENCE

\============================================================

&nbsp;

Users must be able to export individual reports independently.

&nbsp;

Expected workflow:

&nbsp;

Select Report

&nbsp;&nbsp;&nbsp;&nbsp;|

&nbsp;&nbsp;&nbsp;&nbsp;v

Choose Reporting Period

&nbsp;&nbsp;&nbsp;&nbsp;|

&nbsp;&nbsp;&nbsp;&nbsp;v

Choose Applicable Filters

&nbsp;&nbsp;&nbsp;&nbsp;|

&nbsp;&nbsp;&nbsp;&nbsp;v

Generate Report

&nbsp;&nbsp;&nbsp;&nbsp;|

&nbsp;&nbsp;&nbsp;&nbsp;v

Download Excel Workbook

&nbsp;

Examples:

&nbsp;

Analytics \> Reports \> Sales Register \> Export Excel

&nbsp;

Analytics \> Reports \> Inventory Valuation \> Export Excel

&nbsp;

Analytics \> Reports \> Customer Outstanding \> Export Excel

&nbsp;

Do not require users to download every report merely to obtain one.

&nbsp;

Each report must contain only the information relevant to that report.

&nbsp;

Do not include unrelated worksheets in an individual report workbook.

&nbsp;

\============================================================

10\. REPORT FILTERS AND FINANCIAL YEAR

\============================================================

&nbsp;

Inspect and reuse the existing Financial Year implementation.

&nbsp;

Support the reporting period controls appropriate to the existing application.

&nbsp;

At minimum, preserve correct Financial Year semantics and support date-range filtering where applicable.

&nbsp;

Use existing date presets where available.

&nbsp;

Potential presets include:

\- This Month

\- This Quarter

\- This Financial Year

\- Custom Range

&nbsp;

These are examples; reuse established FUSION ONE conventions.

&nbsp;

Filters must be consistent between:

\- Reports UI

\- report data queries

\- individual exports

\- consolidated report pack

&nbsp;

Use the correct business date for each report.

&nbsp;

Do not blindly filter everything by created\_at.

&nbsp;

For example:

\- sales reports must use the correct sales/invoice date

\- purchase reports must use the correct purchase date

\- payment reports must use the correct payment date

\- inventory ageing must use the appropriate acquisition date

&nbsp;

Inspect actual schema and domain semantics before implementing filters.

&nbsp;

Do not create a second independent Financial Year calculation.

&nbsp;

\============================================================

11\. REPORT DATA CORRECTNESS

\============================================================

&nbsp;

All reports must reuse authoritative FUSION ONE business semantics.

&nbsp;

Inspect the existing definitions for:

\- sales totals

\- invoice status

\- amounts received

\- outstanding balances

\- purchases

\- payments

\- customer balances

\- supplier balances

\- inventory valuation

\- inventory status

\- trade-in lifecycle

\- proforma lifecycle

\- cancellations

\- recovery transactions

&nbsp;

Do not invent new formulas for the Excel exporter.

&nbsp;

Do not independently calculate values differently in:

\- existing business pages

\- Analytics

\- report queries

\- Excel worksheets

&nbsp;

If existing calculations are scattered, refactor them into an appropriate shared query/domain architecture.

&nbsp;

However, do not centralize unrelated code merely for the appearance of abstraction.

&nbsp;

Create reusable boundaries only where they have real semantic value.

&nbsp;

\============================================================

12\. SALES REGISTER — ITEM NAME REQUIREMENT

\============================================================

&nbsp;

The Sales Register MUST show the item name alongside the invoice number.

&nbsp;

The Item Name column must appear immediately AFTER the Invoice No. column.

&nbsp;

Required column ordering:

&nbsp;

Date

Invoice No.

Item Name

Customer

Total Amount

Received

Balance

Status

&nbsp;

Adapt column names to the actual business schema where necessary, but preserve the explicit Item Name requirement and its position directly after Invoice No.

&nbsp;

Example:

&nbsp;

Date       Invoice No.    Item Name             Customer     Total    Received    Balance

\------------------------------------------------------------------------------------------

05-Oct     INV-1042       Samsung Galaxy S25    Customer A   ...

06-Oct     INV-1043       iPhone 15             Customer B   ...

&nbsp;

The example is illustrative only.

&nbsp;

Use actual item names from the existing invoice-to-inventory/product relationships.

&nbsp;

Do not invent item names.

&nbsp;

Do not substitute an internal ID for an item name.

&nbsp;

Do not use unrelated product data.

&nbsp;

Do not add quantity columns.

&nbsp;

IMPORTANT MULTI-ITEM HANDLING:

&nbsp;

Inspect the actual invoice and inventory relationships.

&nbsp;

If an invoice can contain multiple relevant items, the report must show all relevant item names in a readable way.

&nbsp;

Choose the correct representation based on the actual data model.

&nbsp;

Possible valid approaches include:

\- one invoice row with item names joined into a readable cell

\- a properly structured invoice-level and item-detail report

&nbsp;

Do not duplicate invoice totals in a way that causes a user to sum them multiple times.

&nbsp;

If using multiple rows for item details, distinguish invoice-level totals from item-level details and ensure totals reconcile correctly.

&nbsp;

If the existing model represents one item per invoice, use the actual single item name.

&nbsp;

Apply this requirement consistently to:

\- standalone Sales Register export

\- Sales Register sheet in the consolidated report pack

\- relevant report previews or report tables where appropriate

&nbsp;

Test item names against real controlled TEST Supabase records.

&nbsp;

Verify:

\- invoice-to-item mapping

\- invoices with multiple items, if supported

\- missing or deleted item references

\- invoices whose associated inventory has changed state

\- cancelled/recovery cases where relevant

&nbsp;

Never invent a fallback item name.

&nbsp;

If the item name is unavailable, handle it honestly and consistently.

&nbsp;

\============================================================

13\. EXCEL WORKBOOK DESIGN — NO RANDOM OBJECTS

\============================================================

&nbsp;

The existing workbook's random-looking object placement must be eliminated.

&nbsp;

The default report design must use worksheet cells, tables, formatting, and appropriate native Excel features.

&nbsp;

Do not use floating shapes or text boxes as the primary layout mechanism.

&nbsp;

Do not insert charts into ordinary report sheets merely to make them look attractive.

&nbsp;

Do not position visual elements arbitrarily.

&nbsp;

Do not reproduce a webpage or dashboard inside a worksheet.

&nbsp;

The report must be a proper spreadsheet.

&nbsp;

\============================================================

14\. STANDARD WORKSHEET LAYOUT

\============================================================

&nbsp;

Use a consistent layout for all reports, adapted to the report's purpose.

&nbsp;

Recommended structure:

&nbsp;

Rows near the top:

\- configured store name

\- report title

\- Financial Year

\- reporting period

\- relevant filter context

\- generation date

&nbsp;

Then:

\- report column headers

\- actual business records

\- appropriate totals or summaries

&nbsp;

Use predictable cell ranges and spacing.

&nbsp;

Keep the report readable without requiring the user to manually reposition columns, rows, or objects.

&nbsp;

Do not force every report to use identical columns.

&nbsp;

Each report has its own meaningful structure while sharing common formatting conventions.

&nbsp;

\============================================================

15\. PROFESSIONAL EXCEL STYLING

\============================================================

&nbsp;

The workbook must look professionally designed and suitable for real business use.

&nbsp;

The style should be restrained, polished, consistent, and human-readable.

&nbsp;

Use:

\- clear typography hierarchy

\- consistent title placement

\- professional column headers

\- appropriate row heights

\- appropriate column widths

\- readable number alignment

\- consistent currency formatting

\- consistent date formatting

\- meaningful totals

\- sensible borders

\- deliberate spacing

\- clear separation between metadata and the report table

\- filters

\- frozen headers

\- sensible sheet names

\- print configuration

\- repeating table headers on printed pages where appropriate

&nbsp;

Avoid:

\- random colors

\- excessive decorative colors

\- excessive borders

\- huge empty spaces

\- overlapping content

\- arbitrary shapes

\- inconsistent alignment

\- excessively large titles

\- technical clutter

\- raw JSON

\- raw database dumps

\- meaningless IDs

\- SQL-style column names

\- fake business details

&nbsp;

Use real Excel numeric cells for amounts.

&nbsp;

Do not store currency values as formatted text strings.

&nbsp;

Apply appropriate ₹ number formats without compromising numeric behavior.

&nbsp;

Use proper Excel date values.

&nbsp;

Ensure sorting, filtering, and arithmetic continue to work.

&nbsp;

\============================================================

16\. HUMAN-GENERATED REPORT QUALITY

\============================================================

&nbsp;

The reports should resemble workbooks prepared by a competent business reporting specialist.

&nbsp;

They must not look like an AI-generated dashboard converted into Excel.

&nbsp;

Achieve this through:

\- sensible column selection

\- natural information hierarchy

\- meaningful report titles

\- consistent formatting

\- readable table structures

\- relevant totals

\- restrained visual design

\- appropriate number formatting

\- realistic column widths

\- sensible print layouts

\- no redundant information

\- no unnecessary charts

\- no decorative objects

\- no arbitrary styling differences between sheets

&nbsp;

Do not attempt to achieve professionalism by adding more visual elements.

&nbsp;

Professionalism comes from correctness, organization, consistency, and readability.

&nbsp;

\============================================================

17\. EXCEL TABLES, FILTERS, AND PRINTING

\============================================================

&nbsp;

Where applicable, use native Excel tables or equivalent structured ranges.

&nbsp;

Support:

\- filtering

\- sorting

\- frozen header rows

\- appropriate column widths

\- appropriate numeric formats

\- date formats

\- totals where meaningful

\- print areas

\- print orientation

\- margins

\- repeated headers on subsequent printed pages

&nbsp;

Avoid creating invalid or overlapping Excel tables.

&nbsp;

Handle empty datasets correctly.

&nbsp;

An empty report must still have a clear title, period, column headers, and an understandable empty state.

&nbsp;

Do not create fake rows to make the workbook look populated.

&nbsp;

\============================================================

18\. OPTIONAL CONSOLIDATED REPORT PACK

\============================================================

&nbsp;

Implement an optional action such as:

&nbsp;

Export Complete Report Pack

&nbsp;

This must create one workbook containing the supported business reports as separate, well-named worksheets.

&nbsp;

A simple Report Index worksheet may identify:

\- report name

\- reporting period

\- relevant filters

&nbsp;

A dashboard is optional and NOT required.

&nbsp;

Do not create a decorative dashboard as a substitute for the reports.

&nbsp;

Suggested sheets, where supported:

&nbsp;

\- Report Index

\- Sales Register

\- Sales Summary

\- Purchase Register

\- Purchase Summary

\- Payments Register

\- Customer Outstanding

\- Receivables Ageing

\- Inventory Register

\- Inventory Valuation

\- Inventory Ageing

\- Trade-In Register

\- Proforma Register

&nbsp;

Adjust the final list according to the actual report catalogue.

&nbsp;

Do not include unsupported or fake reports.

&nbsp;

Every worksheet must be independently readable and correctly formatted.

&nbsp;

Individual exports and the consolidated workbook must reuse the same report definitions and renderer.

&nbsp;

\============================================================

19\. EXCEL ARCHITECTURE

\============================================================

&nbsp;

Create a common report-generation infrastructure that handles:

\- workbook creation

\- worksheet creation

\- report titles

\- metadata

\- column definitions

\- cell formatting

\- numeric formats

\- date formats

\- filters

\- frozen panes

\- totals

\- print configuration

\- filenames

\- worksheet naming

\- empty reports

\- error handling

&nbsp;

Each report definition should declare its specific columns, data source, filters, sorting, and relevant totals.

&nbsp;

Do not create a separate hardcoded renderer for every report.

&nbsp;

Do not build one giant conditional function with duplicated formatting logic for every report.

&nbsp;

Use the repository's existing language, dependencies, and architecture where suitable.

&nbsp;

Before adding dependencies, inspect what is already installed.

&nbsp;

Do not introduce another Excel library unless there is a clear technical reason.

&nbsp;

\============================================================

20\. REPORTS UI

\============================================================

&nbsp;

Follow the existing FUSION ONE design system.

&nbsp;

Inspect the existing Analytics \> Reports page before changing it.

&nbsp;

Reuse:

\- existing page headers

\- buttons

\- cards

\- tables

\- filters

\- dialogs

\- typography

\- spacing

\- colors

\- loading states

\- empty states

\- error handling

&nbsp;

The Reports page should make the report catalogue easy to understand.

&nbsp;

Each report should have:

\- a meaningful title

\- a concise explanation of its purpose

\- applicable filter controls

\- an export action

\- proper loading and error handling

&nbsp;

Avoid adding excessive nested navigation.

&nbsp;

Do not redesign unrelated application screens.

&nbsp;

Do not create a second UI design system.

&nbsp;

\============================================================

21\. ANALYTICS INTEGRATION

\============================================================

&nbsp;

The existing Analytics primary sections remain:

&nbsp;

\- Overview

\- Sales

\- Money

\- Inventory

\- Reports

&nbsp;

This task focuses on reimplementing Reports and its supporting architecture.

&nbsp;

However, report queries must integrate correctly with the existing Analytics model.

&nbsp;

Where appropriate:

\- Sales Register totals must reconcile with Sales Analytics.

\- Payments Register totals must reconcile with Money Analytics.

\- Outstanding reports must reconcile with authoritative receivables calculations.

\- Inventory Valuation must reconcile with authoritative inventory valuation.

\- Trade-In reports must respect existing trade-in lifecycle semantics.

&nbsp;

Do not independently implement Analytics features that already exist and are outside the reporting changes.

&nbsp;

Only refactor adjacent Analytics code when necessary to eliminate conflicting business calculations or establish a clean shared architecture.

&nbsp;

\============================================================

22\. NOTICE INTEGRATION

\============================================================

&nbsp;

Preserve the existing Notice architecture and the previously agreed shared-business-truth requirement.

&nbsp;

Reports must not create a competing definition of:

\- overdue receivables

\- inventory ageing

\- actionable proformas

\- other conditions used by Notices

&nbsp;

If a report and a Notice use the same underlying business condition, reuse the same authoritative semantics.

&nbsp;

Do not create a new notification framework as part of the Excel reimplementation.

&nbsp;

Do not add unrelated Notice features.

&nbsp;

\============================================================

23\. CONTROLLED TEST DATA

\============================================================

&nbsp;

You MUST add the necessary controlled test data to TEST Supabase where existing data is insufficient.

&nbsp;

First inspect the existing TEST dataset.

&nbsp;

Do not overwrite or delete unrelated data.

&nbsp;

Use the application's established database fixture or seeding conventions where available.

&nbsp;

If dedicated test fixtures are needed, make them deterministic, identifiable, and safe to clean up.

&nbsp;

The test dataset must cover:

&nbsp;

SALES:

\- multiple invoices

\- different supported payment states

\- relevant reporting periods

\- item names

\- multiple items per invoice if the model supports them

\- cancelled transactions where relevant

&nbsp;

PURCHASES:

\- multiple purchase records

\- relevant reporting periods

&nbsp;

PAYMENTS:

\- incoming payments

\- outgoing payments

\- supported payment modes

\- partial payments where supported

&nbsp;

RECEIVABLES:

\- different outstanding balances

\- different due-date scenarios where supported

&nbsp;

INVENTORY:

\- multiple inventory records

\- different brands and models where available

\- different acquisition dates

\- relevant inventory states

\- supported valuation cases

&nbsp;

TRADE-INS:

\- relevant acquisition and lifecycle scenarios

&nbsp;

PROFORMAS:

\- relevant statuses and conversion states

&nbsp;

FINANCIAL YEARS:

\- records that test period boundaries and Financial Year filtering

&nbsp;

Do not use mock values in application code.

&nbsp;

All business report calculations must be tested against real TEST database records or controlled fixtures compatible with the actual schema.

&nbsp;

\============================================================

24\. EXPECTED-RESULT VERIFICATION

\============================================================

&nbsp;

For the controlled test dataset, independently determine the expected results.

&nbsp;

Examples:

\- expected invoice count

\- expected sales total

\- expected amount received

\- expected outstanding balance

\- expected purchase total

\- expected payment totals by mode

\- expected inventory record count

\- expected inventory valuation

\- expected ageing classifications

\- expected trade-in totals

&nbsp;

The expected values must be calculated independently of the Excel renderer.

&nbsp;

Do not use the same potentially faulty helper function to calculate both the expected result and the actual result.

&nbsp;

Create assertions that detect actual discrepancies.

&nbsp;

Verify report filters and totals.

&nbsp;

Verify Financial Year boundaries.

&nbsp;

Verify cancellations and recovery transactions.

&nbsp;

Verify item names.

&nbsp;

\============================================================

25\. EXCEL STRUCTURAL TESTING

\============================================================

&nbsp;

Generate actual workbooks for the supported individual reports and the consolidated report pack.

&nbsp;

Programmatically inspect the generated files.

&nbsp;

Verify:

\- workbook can be opened and parsed

\- expected worksheets exist

\- sheet names are correct

\- store branding is correct

\- report titles are correct

\- metadata is correct

\- column headers are correct

\- column ordering is correct

\- Sales Register has Item Name immediately after Invoice No.

\- quantity fields have not been introduced

\- records match the selected reporting period

\- totals reconcile

\- currency values are numeric

\- dates are valid Excel dates

\- number formats are correct

\- filters exist where applicable

\- frozen panes exist where applicable

\- print settings are present

\- no fake values exist

\- no placeholder sections exist

\- no unexpected technical columns exist

&nbsp;

Verify individual reports separately.

&nbsp;

Also verify the consolidated workbook.

&nbsp;

\============================================================

26\. EXCEL VISUAL VERIFICATION — MANDATORY

\============================================================

&nbsp;

THIS IS A REQUIRED COMPLETION GATE.

&nbsp;

Do not merely inspect the XLSX source code.

&nbsp;

Do not merely verify that a file exists.

&nbsp;

Do not merely verify that the workbook contains the expected cells.

&nbsp;

Generate actual XLSX files and inspect their rendered appearance using available spreadsheet-compatible tooling.

&nbsp;

Use the available environment to render representative worksheets or open them in an appropriate spreadsheet application.

&nbsp;

Inspect at least:

\- Sales Register

\- Purchase Register

\- Payments Register

\- Customer Outstanding or Receivables Ageing

\- Inventory Register

\- Inventory Valuation

\- Trade-In Register

\- Proforma Register where supported

\- the Report Index

\- representative sheets from the consolidated workbook

&nbsp;

Inspect the actual rendered output.

&nbsp;

Check for:

\- overlapping content

\- clipped text

\- unreasonable column widths

\- excessively wide worksheets

\- excessive blank areas

\- inconsistent headers

\- inconsistent typography

\- misaligned currency values

\- unreadable dates

\- missing item names

\- duplicate invoice totals

\- awkward pagination

\- unnecessary decorative objects

\- inconsistent formatting across sheets

\- poor print layout

&nbsp;

Correct every meaningful defect discovered.

&nbsp;

Regenerate the workbook after making corrections.

&nbsp;

Inspect the corrected output again.

&nbsp;

Do not claim that a workbook is visually verified if you have only examined its source code or cell values.

&nbsp;

If the environment lacks a particular visual inspection tool, use the best available alternative and explicitly report what was and was not visually inspected.

&nbsp;

\============================================================

27\. RECONCILIATION BETWEEN DATA, ANALYTICS, AND EXCEL

\============================================================

&nbsp;

For every report tested, verify the chain:

&nbsp;

TEST DATABASE

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;\=

AUTHORITATIVE BUSINESS QUERY

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;\=

REPORT DATA

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;\=

EXCEL OUTPUT

&nbsp;

Where the corresponding Analytics metric exists, verify:

&nbsp;

ANALYTICS

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;\=

CORRESPONDING REPORT TOTAL

&nbsp;

Respect differences in reporting period and scope.

&nbsp;

Do not force totals to match when the reports intentionally cover different periods or transaction categories.

&nbsp;

Document legitimate differences.

&nbsp;

Never conceal a discrepancy.

&nbsp;

\============================================================

28\. AUTOMATED TESTS

\============================================================

&nbsp;

Add and run appropriate tests for:

&nbsp;

REPORT DEFINITIONS:

\- correct columns

\- correct column order

\- correct report metadata

\- correct filters

\- correct sorting

\- correct totals

&nbsp;

DATA:

\- sales calculations

\- purchase calculations

\- payments

\- outstanding balances

\- inventory valuation

\- ageing

\- trade-in lifecycle

\- proforma status

\- cancellation and recovery semantics

\- Financial Year boundaries

&nbsp;

SALES REGISTER:

\- Item Name immediately follows Invoice No.

\- actual item names are retrieved correctly

\- multiple-item invoices are represented correctly where supported

\- invoice totals are not duplicated incorrectly

\- missing item references are handled honestly

&nbsp;

EXCEL:

\- workbook generation

\- worksheet names

\- worksheet contents

\- number formats

\- currency formatting

\- date formatting

\- filters

\- frozen panes

\- print settings

\- empty datasets

\- consolidated workbook

&nbsp;

FRONTEND:

\- report catalogue

\- filter selection

\- individual export actions

\- complete report pack action

\- loading states

\- empty states

\- error states

&nbsp;

REGRESSION:

\- existing business functionality

\- existing Analytics functionality

\- existing Notice functionality where relevant

&nbsp;

Run the repository's existing tests as well as the new tests.

&nbsp;

Do not remove or weaken existing tests simply to make the new implementation pass.

&nbsp;

\============================================================

29\. FAILURE HANDLING

\============================================================

&nbsp;

Do not silently generate incomplete or misleading reports.

&nbsp;

If a query fails:

\- surface an appropriate error

\- do not silently replace the result with zero

\- do not create a fake empty report that appears successful

&nbsp;

If a dataset is genuinely empty:

\- generate a correctly structured empty report

\- retain its title and reporting metadata

\- include the correct headers

\- make the empty state clear

&nbsp;

If a report cannot be supported by the existing data model:

\- investigate whether it can be implemented accurately

\- if not, document the limitation

\- do not fabricate the missing information

&nbsp;

\============================================================

30\. SECURITY AND AUTHORIZATION

\============================================================

&nbsp;

Follow existing FUSION ONE authorization conventions.

&nbsp;

Reports must only contain data the current user is authorized to access.

&nbsp;

Do not expose secrets, service-role credentials, or unrelated business data.

&nbsp;

Do not move privileged database operations to the browser for convenience.

&nbsp;

Use the correct established backend/frontend boundary for the current architecture.

&nbsp;

\============================================================

31\. NO PATCHWORK IMPLEMENTATION

\============================================================

&nbsp;

Do not solve architectural problems with:

\- arbitrary positioning offsets

\- setTimeout

\- forced reloads

\- duplicated state

\- hardcoded values

\- silent fallbacks

\- fake data

\- temporary files left behind

\- duplicate exporters

\- duplicate formulas

\- hidden compatibility flags

\- unnecessary libraries

\- one-off formatting hacks

\- empty placeholder sections

&nbsp;

If the existing exporter is fundamentally unsuitable, refactor or replace it properly.

&nbsp;

Preserve existing business behavior.

&nbsp;

Do not retain obsolete implementations indefinitely.

&nbsp;

\============================================================

32\. IMPLEMENTATION SEQUENCE

\============================================================

&nbsp;

Follow this sequence.

&nbsp;

PHASE 1 — INSPECT

Read CURRENT\_SYSTEM\_SUMMARY and inspect the actual repository.

&nbsp;

PHASE 2 — AUDIT

Trace the current Reports UI, business queries, workbook generator, and download flow.

&nbsp;

PHASE 3 — DATA MODEL

Identify authoritative business sources and confirm the absence of a quantity field for this reporting requirement.

&nbsp;

PHASE 4 — REPORT CATALOGUE

Define the supported reports, their columns, filters, date semantics, and totals.

&nbsp;

PHASE 5 — REPORT ARCHITECTURE

Refactor the current export architecture into shared report definitions, normalized report data, and a common Excel renderer.

&nbsp;

PHASE 6 — EXCEL DESIGN

Implement the common professional worksheet layout and store branding.

&nbsp;

PHASE 7 — INDIVIDUAL REPORTS

Implement the supported individual report exports.

&nbsp;

PHASE 8 — ITEM NAME

Ensure Sales Register includes Item Name immediately after Invoice No., including the consolidated workbook.

&nbsp;

PHASE 9 — CONSOLIDATED WORKBOOK

Implement the optional Complete Report Pack using the same report definitions and renderer.

&nbsp;

PHASE 10 — UI INTEGRATION

Integrate the report catalogue and export flows into the existing Analytics \> Reports interface.

&nbsp;

PHASE 11 — TEST DATA

Create controlled TEST data without damaging unrelated records.

&nbsp;

PHASE 12 — NUMERICAL TESTING

Verify known results independently.

&nbsp;

PHASE 13 — WORKBOOK STRUCTURAL TESTING

Inspect actual XLSX structures and contents.

&nbsp;

PHASE 14 — VISUAL TESTING

Render and inspect actual workbook output.

&nbsp;

PHASE 15 — CORRECTIONS

Correct all meaningful defects discovered and regenerate the affected workbooks.

&nbsp;

PHASE 16 — REGRESSION

Run relevant existing application tests.

&nbsp;

PHASE 17 — CLEANUP

Remove obsolete exporters, duplicate calculations, unused code, and unfinished artifacts.

&nbsp;

PHASE 18 — COMPLETENESS AUDIT

Verify every requirement in this prompt before reporting completion.

&nbsp;

\============================================================

33\. STRICT COMPLETENESS GATE

\============================================================

&nbsp;

Do not declare completion until all applicable requirements below are verified.

&nbsp;

REPORTS:

\[ \] Report catalogue implemented

\[ \] Individual exports implemented

\[ \] Supported report types completed

\[ \] Consolidated report pack implemented

\[ \] Shared report-generation architecture established

\[ \] Filters implemented correctly

\[ \] Financial Year semantics verified

\[ \] Authoritative business calculations reused

\[ \] No quantity fields invented

&nbsp;

BRANDING:

\[ \] Store name retrieved from authoritative configuration

\[ \] Store name used as primary report heading

\[ \] FUSION ONE is not used as business branding

\[ \] Missing configuration handled correctly

\[ \] Filenames are meaningful and safe

&nbsp;

SALES REGISTER:

\[ \] Invoice number included

\[ \] Item Name immediately after Invoice No.

\[ \] Item names retrieved from actual relationships

\[ \] Multiple-item invoices handled correctly where supported

\[ \] Invoice totals reconcile

\[ \] No quantity column

&nbsp;

EXCEL QUALITY:

\[ \] Consistent professional layout

\[ \] No random floating objects

\[ \] No overlapping content

\[ \] Correct column widths

\[ \] Correct date formats

\[ \] Correct ₹ formatting

\[ \] Numeric values remain numeric

\[ \] Filters work

\[ \] Frozen headers work

\[ \] Print settings are appropriate

\[ \] Empty reports work

\[ \] No placeholder sections

\[ \] No technical clutter

&nbsp;

DATA:

\[ \] Controlled TEST scenarios created

\[ \] Expected results independently established

\[ \] Sales reconciled

\[ \] Purchases reconciled

\[ \] Payments reconciled

\[ \] Outstanding balances reconciled

\[ \] Inventory valuation reconciled

\[ \] Ageing verified

\[ \] Item names verified

\[ \] Financial Year boundaries verified

&nbsp;

VISUAL VERIFICATION:

\[ \] Actual XLSX files generated

\[ \] Representative individual reports visually inspected

\[ \] Consolidated workbook inspected

\[ \] Meaningful defects corrected

\[ \] Corrected workbooks regenerated

\[ \] Final output inspected again

&nbsp;

REGRESSION:

\[ \] Existing relevant tests pass

\[ \] New tests pass

\[ \] Typecheck passes

\[ \] Relevant database tests pass

\[ \] Existing functionality remains intact

&nbsp;

SAFETY:

\[ \] TEST Supabase used exclusively

\[ \] Production Supabase not accessed

\[ \] No production mutations

\[ \] No secrets exposed

&nbsp;

QUALITY:

\[ \] No required TODOs

\[ \] No stubs

\[ \] No fake metrics

\[ \] No unfinished report types presented as complete

\[ \] No obsolete duplicate exporter

\[ \] Final implementation report accurately reflects actual verification

&nbsp;

\============================================================

34\. FINAL REPORT

\============================================================

&nbsp;

When finished, provide an English-only report containing:

&nbsp;

1\. Summary of the reimplementation.

2\. Reports implemented.

3\. Architecture refactored.

4\. How report definitions and the shared renderer work.

5\. How store branding is retrieved.

6\. How Item Name is populated beside Invoice No.

7\. Confirmation that quantity fields were not invented.

8\. TEST data created and scenarios tested.

9\. Expected versus actual values for representative calculations.

10\. Excel workbooks generated.

11\. Structural checks performed.

12\. Visual inspections actually performed.

13\. Defects discovered and corrected.

14\. Test commands and actual results.

15\. Regression results.

16\. Confirmation that production Supabase was not accessed.

17\. Any genuine remaining limitations.

&nbsp;

Do not claim visual inspection unless the actual workbook output was inspected.

&nbsp;

Do not claim tests passed unless they were executed.

&nbsp;

Do not report planned work as completed work.

&nbsp;

\============================================================

FINAL DIRECTIVE

\============================================================

&nbsp;

Reimplement the Reports system properly.

&nbsp;

Do not merely restyle the existing broken workbook.

&nbsp;

Build a coherent reporting architecture.

Reuse authoritative business logic.

Use the configured store name.

Do not invent quantity fields.

Show Item Name immediately after Invoice No.

Implement individual business reports.

Implement the optional consolidated report pack.

Use professional worksheet layouts.

Eliminate randomly positioned objects.

Populate controlled TEST data.

Verify expected values independently.

Generate actual Excel workbooks.

Inspect their structure.

Inspect their rendered appearance.

Correct defects.

Regenerate and re-inspect the corrected workbooks.

Run regression tests.

Remove obsolete code.

&nbsp;

Use TEST Supabase exclusively.

&nbsp;

Do not use production Supabase.

&nbsp;

Do not generate Chinese.

&nbsp;

Do not leave stubs, TODOs, placeholders, or unfinished required features.

&nbsp;

The implementation is complete only when the reports are functionally correct, numerically verified, professionally presented, and actually inspected.

&nbsp;