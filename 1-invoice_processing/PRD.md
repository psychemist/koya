# **Intelligent Invoice Processing**

## Introduction

Novus Realty receives invoices from vendors, utility companies, contractors, and service providers. Some invoices arrive as PDF attachments. Others appear directly in the email body.

An admin assistant currently opens each invoice email, finds the important details, and logs them into a Google Sheet. The work is repetitive and easy to get wrong when invoices use different layouts or omit information.

Your task is to build an automation that monitors a Gmail inbox, identifies invoice emails, extracts structured invoice details with Claude, validates the result, and logs the invoice into Google Sheets.

## Project Objective

Build a working invoice-processing automation that can handle common invoice formats and realistic failure cases.

By the end of this project, your system should:

- Monitor Gmail for incoming invoice-related emails
- Detect invoices from email subjects, email bodies, or attachments
- Extract invoice text from PDF attachments or email body content
- Use Claude to convert unstructured invoice text into structured data
- Validate the extracted fields before logging
- Save valid invoice records to Google Sheets
- Avoid duplicate invoice entries
- Handle missing fields, irrelevant emails, and broken files without crashing

## Core Tools

Use the following tools:

- **n8n** for workflow automation
- **Gmail** as the invoice source
- **Claude** through the Anthropic API or n8n Claude integration
- **PDF/document extraction tool** to convert PDF attachments into raw text
- **Google Sheets** as the structured invoice log

You may use additional helper tools if they improve reliability, but the core workflow should stay understandable.

## Required Invoice Fields

Extract and log these fields when available:

- Vendor name
- Sender email
- Invoice number
- Invoice date
- Due date
- Total amount
- Currency
- Invoice description or line-item summary
- Source type: `pdf_attachment` or `email_body`
- File URL or attachment reference, where available
- Processing status
- Error note, where applicable

If a field is missing from the invoice, do not invent it. Leave the field blank or mark it as missing, then record the issue in the processing status or error note.

## System Workflow

Your automation should follow this flow:

1. **Monitor Gmail**
    
    Watch a Gmail inbox for new emails that may contain invoices.
    
2. **Identify Invoice Candidates**
    
    Use filters or logic to identify invoice-related emails. Subject-line keywords such as `invoice`, `billing`, `payment`, or `receipt` can help, but your workflow should also account for invoice details that appear in the email body.
    
3. **Prepare the Invoice Text**
    
    Check whether the email contains a PDF attachment.
    
    - If a PDF is attached, use a PDF/document extraction tool to convert the file into raw text.
    - If no PDF is attached, use the email body as the invoice source.
    
    You may combine this with another step if your tool setup supports it, but your workflow should make the source of the invoice text clear.
    
4. **Extract Invoice Fields with Claude**
    
    Send the raw invoice text to Claude so it can identify the invoice fields and return structured data.
    
    The output should be easy to map into Google Sheets. JSON or another structured format is preferred.
    
5. **Validate the Extraction**
    
    Before writing to Google Sheets, check that important fields are present and formatted correctly.
    
    At minimum, validate:
    
    - Invoice number, when available
    - Vendor name
    - Total amount
    - Currency
    - Invoice date or due date, when available
6. **Check for Duplicates**
    
    Prevent the same invoice from creating multiple rows.
    
    You can check duplicates using invoice number, sender email, file name, Gmail message ID, or a combination of fields.
    
7. **Log the Result**
    
    Add a row to Google Sheets for valid invoice records.
    
    If the workflow cannot process an email, log or notify the failure with enough detail to debug it later.
    

#### Required Test Pack

Test your automation against a range of invoice and non-invoice inputs. The goal is to prove that the workflow behaves correctly across realistic cases.

**Use the program's test pack.** The invoice attachments are in the shared Drive folder — Cohort 3 — Week 1 Test Pack. The ten emails are below.

Send each one to yourself: copy the subject and the body, attach the file named on that email, and send it to your own address. Your Gmail trigger watches your inbox, so the mail has to arrive there. It takes about ten minutes.

**Copy the bodies as they are, don't reword them.** Several of these emails are testing whether your workflow can tell an invoice from something that merely looks like one, and the wording is what does the testing.

**Send TP-05 last, after your workflow has already logged TP-01.** It is the same invoice again. If it arrives before the original has been written, there is no existing row to match it against — and a workflow with no duplicate handling at all will appear to pass.

**Ten emails, eight cases.** Two of the cases below are covered by two emails each, because one example was not enough to prove the behaviour. Your evidence table therefore has ten rows, not eight.

### The ten emails

- **TP-01 — Normal invoice**  ·  meridian-INV-4471.pdf
    
    **Subject:** Invoice INV-4471 from Meridian Plumbing & HVAC
    
    **Attach:** `meridian-INV-4471.pdf`

Hi Accounts Payable,

Please find attached invoice INV-4471 covering the emergency boiler repair at 14 Ashford Court and this quarter's HVAC servicing.

Payment terms are net 30. Let us know if you need anything else.

Kind regards,
Daniel Okoro
Accounts, Meridian Plumbing & HVAC

- **TP-02 — Different invoice layout**  ·  harcourt-HFM-2026-0815.pdf
    
    **Subject:** August charges - Harcourt Facilities Management
    
    **Attach:** `harcourt-HFM-2026-0815.pdf`
    
    ```
    Good morning,
    
    Attached is our statement of charges for August. As always, please quote the reference shown when you pay.
    
    Best,
    Sade Aluko
    Harcourt Facilities Management
    ```
    
- **TP-03 — Invoice in email body**  ·  no attachment
    
    **Subject:** Invoice INV-2038 from Brightline Solutions
    
    **Attach:** no attachment
    
    ```
    
    ```
```
Dear Customer,

Thank you for your continued business. Please find below the details of your latest invoice:

Vendor: Brightline Solutions
Invoice Number: INV-2038
Invoice Date: August 12, 2026
Due Date: August 26, 2026
Total Amount: $1,750.00

Description: Monthly subscription for property management software (Enterprise Plan) covering August 2026.

If you have any questions regarding this invoice, contact us at billing@brightlinesolutions.com.

Best regards,
The Brightline Team
```

- **TP-04 — Missing required field**  ·  castellan-fee-note-aug.pdf
    
    **Subject:** Fee note - Q3 tenancy renewals
    
    **Attach:** `castellan-fee-note-aug.pdf`
    
    ```
    Dear Accounts Payable,
    
    Please see the attached fee note for the Q3 renewal programme.
    
    Yours sincerely,
    Marcus Castellan
    Castellan Legal Partners LLP
    ```
    
- **TP-05 — Duplicate invoice**  ·  meridian-INV-4471.pdf
    
    **Subject:** Invoice INV-4471 from Meridian Plumbing & HVAC
    
    **Attach:** `meridian-INV-4471.pdf`
    
    ```
    Hi Accounts Payable,
    
    Apologies for the repeat message - resending invoice INV-4471 as we weren't sure the first one reached you.
    
    Kind regards,
    Daniel Okoro
    Accounts, Meridian Plumbing & HVAC
    ```
    
- **TP-06a — Non-invoice email**  ·  no attachment
    
    **Subject:** Payment reminder: update your Novus Realty tenant portal details
    
    **Attach:** no attachment
    
    ```
    Hello,
    
    This is an automated reminder that the payment method saved on your Novus Realty tenant portal account expires soon. To avoid interruption to your billing, please sign in and update your card details.
    
    Reference: PRT-99413
    Action required by: 31 August 2026
    
    This is a notification only. No payment is due at this time.
    
    The Novus Realty Portal Team
    ```
- **TP-06b — Non-invoice email**  ·  no attachment
    
    **Subject:** Novus Weekly: three completions, and invoicing moves to the new portal
    
    **Attach:** no attachment
    
    ```
    Hi all,
    
    A short one this week.
    
    Three completions landed on Friday, taking us to eleven for the quarter. Thanks to everyone who pushed on the Ashford Court chain.
    
    Operations note: from 1 September all supplier invoices move to the new portal. If you currently email invoices to accounts@, keep doing that until you hear otherwise - we will confirm the cutover date.
    
    Have a good week,
    The Novus Realty team
    ```
    
- **TP-07a — Unsupported or corrupt attachment**  ·  oakridge-scan-damaged.pdf
    
    **Subject:** Invoice OPS-88214 - Oakridge Print & Signage
    
    **Attach:** `oakridge-scan-damaged.pdf`
    
    ```
    Hi,
    
    Invoice attached for the signage run. Our scanner has been playing up so let me know if the file doesn't open properly.
    
    Thanks,
    Oakridge Print & Signage
    ```
    
- **TP-07b — Unsupported or corrupt attachment**  ·  scanned-invoice-no-text-layer.pdf
    
    **Subject:** Scanned invoice - commission statement
    
    **Attach:** `scanned-invoice-no-text-layer.pdf`
    
    ```
    Hi,
    
    Scan of the commission invoice attached.
    
    Regards,
    Fairway Commissions
    ```
- **TP-08 — Unusual formatting**  ·  vendoria-2026-08-VN-113.pdf
    
    **Subject:** Factuur / Invoice 2026-08/VN-113 - Vendoria Interiors B.V.
    
    **Attach:** `vendoria-2026-08-VN-113.pdf`
    
    ```
    Geachte heer/mevrouw,
    
    Bijgaand onze factuur voor de receptie-inrichting.
    
    Dear Sir or Madam, please find attached our invoice for the reception refurbishment. Payment within 30 days.
    
    Met vriendelijke groet,
    Vendoria Interiors B.V.
    ```
    

**Two things worth knowing before you start.**

- **The scanned invoice is meant to be unreadable.** TP-07b is a real invoice — you can open it and read it yourself. Your extractor cannot, because the page is one flat image with no text behind it. Reading it would need OCR, which this project does not cover. The right outcome is that your workflow notices it got nothing usable back and says so, instead of passing an empty string to Claude and logging whatever comes out the other end.
- **Blank beats invented.** Where an invoice genuinely does not carry a field, blank or flagged is the correct answer. A system that fills the gap with a plausible-looking value is worse than one that leaves it empty, because nothing downstream can tell a real invoice number from a manufactured one.

Your test pack must include at least: check attahed screenshot


## Testing Evidence

Submit a test evidence table with your project.

Use this structure:

| Test case | Expected result | Actual result | Passed? | Notes or fix made |
| --- | --- | --- | --- | --- |
| Normal invoice |  |  |  |  |
| Different invoice layout |  |  |  |  |
| Invoice in email body |  |  |  |  |
| Missing required field |  |  |  |  |
| Duplicate invoice |  |  |  |  |
| Non-invoice email |  |  |  |  |
| Unsupported or corrupt attachment |  |  |  |  |
| Unusual formatting |  |  |  |  |

If a test fails at first, include the change you made. For example, you might adjust the prompt, add a validation rule, improve routing, or add an error path.

##
## Deliverables

Submit the following:

1. **Workflow artifact**
    
    Your n8n workflow export or blueprint.
    
2. **Video walkthrough**
    
    A short Loom video showing the automation in action.
    
3. **Testing evidence**
    
    Completed test evidence table with expected vs actual behavior.
    
4. **Reflection sheet**
    
    Answer the questions in your reflection sheet for this project.
    
5. **One-page documentation**
    
    Submit one page of documentation for your system.
    

## Resources

Use the resources below to understand the tools and patterns required for this project. Start with the n8n orientation resources if you are new to the platform, then use the task-specific references while building.

all the bullet points below are links to n8n documentation e.g.: https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.information-extractor

### Start Here

- n8n intro video
- Optional: n8n Quickstart course
- Work with nodes
- Referencing data in the UI

### Build the Workflow

- Gmail Trigger node
- Gmail node: message operations
- IF node
- Switch node
- Extract From File node
- Google Sheets node

### Add AI Extraction

- Information Extractor node
- Get started with Claude

### Test and Debug

- All executions
- n8n learning resources


i want the complete end-to-end n8n workflow to make this work seamlessly.
read participant guide for pointers