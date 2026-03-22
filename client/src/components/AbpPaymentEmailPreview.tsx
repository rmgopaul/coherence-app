import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronLeft, ChevronRight, ClipboardCopy, Eye, EyeOff } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

/* ------------------------------------------------------------------ */
/*  Template types                                                      */
/* ------------------------------------------------------------------ */

export type EmailTemplateType =
  | "first_payment"
  | "first_payment_354pct"
  | "quarterly_5pct"
  | "quarterly_354pct"
  | "negative_balance_354pct";

export const EMAIL_TEMPLATE_LABELS: Record<EmailTemplateType, string> = {
  first_payment: "1st Payment — 20% upfront (fee breakdown)",
  first_payment_354pct: "1st Payment — 15% upfront (fee breakdown + quarterly)",
  quarterly_5pct: "Quarterly 5% (20% upfront, pmt 2–17)",
  quarterly_354pct: "Quarterly 3.54% (15% upfront, pmt 2–25)",
  negative_balance_354pct: "Negative Balance (15% upfront, fees exceed pmt)",
};

/* ------------------------------------------------------------------ */
/*  Shared HTML fragments                                               */
/* ------------------------------------------------------------------ */

const OUTER_START = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f5f9;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">`;

const OUTER_END = `</table>
</td></tr>
</table>
</body>
</html>`;

function headerBlock(): string {
  return `
<!-- Header -->
<tr>
  <td style="background-color:#1e3a5f;padding:24px 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td>
          <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">Carbon Solutions Group</div>
          <div style="font-size:13px;color:#93c5fd;margin-top:4px;">Illinois Shines SREC Program</div>
        </td>
      </tr>
    </table>
  </td>
</tr>`;
}

function contractTransferWarning(): string {
  return `
<!-- Contract Transfer Warning -->
<tr>
  <td style="padding:0 32px 24px 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:2px solid #dc2626;border-radius:8px;overflow:hidden;">
      <tr>
        <td style="background-color:#fef2f2;padding:20px 24px;">
          <div style="font-size:16px;font-weight:700;color:#991b1b;margin-bottom:12px;">&#9888;&#65039; IMPORTANT: Property Sale &amp; Contract Transfer</div>
          <div style="font-size:14px;color:#7f1d1d;line-height:1.7;">
            If you have sold, or are planning to sell, the property where your PV solar system is installed, you <strong>must</strong> contact Carbon Solutions Group immediately to facilitate a transfer of the SREC contract to the buyer.
          </div>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:14px;">
            <tr>
              <td style="padding:4px 0;font-size:14px;color:#991b1b;vertical-align:top;padding-right:8px;">&#8226;</td>
              <td style="padding:4px 0;font-size:14px;color:#991b1b;"><strong>Failure to transfer</strong> the REC contract will require <strong>full repayment</strong> of any RECs not delivered under the contract.</td>
            </tr>
            <tr>
              <td style="padding:4px 0;font-size:14px;color:#991b1b;vertical-align:top;padding-right:8px;">&#8226;</td>
              <td style="padding:4px 0;font-size:14px;color:#991b1b;">Transferring the REC contract <strong>after</strong> the property is sold can be extremely challenging. Resolve this <strong>at the time of closing</strong>.</td>
            </tr>
            <tr>
              <td style="padding:4px 0;font-size:14px;color:#991b1b;vertical-align:top;padding-right:8px;">&#8226;</td>
              <td style="padding:4px 0;font-size:14px;color:#991b1b;">This is <strong>contractually required</strong> &mdash; failure to comply may result in Default.</td>
            </tr>
            <tr>
              <td style="padding:4px 0;font-size:14px;color:#991b1b;vertical-align:top;padding-right:8px;">&#8226;</td>
              <td style="padding:4px 0;font-size:14px;color:#991b1b;">Contact Carbon Solutions so we can provide the <strong>transfer addendum</strong> to the buyer or their agent as early as possible.</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </td>
</tr>`;
}

function paymentAddressTable(v: (key: string) => string): string {
  return `
<!-- Payment Address & Method -->
<tr>
  <td style="padding:0 32px 20px 32px;">
    <div style="font-size:14px;font-weight:600;color:#1e3a5f;margin-bottom:8px;">Payment Address &amp; Method</div>
    <div style="font-size:14px;color:#475569;margin-bottom:12px;">Please review the payment address and payee listed below.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e2e8f0;border-radius:6px;">
      <tr style="background-color:#f8fafc;">
        <td style="padding:10px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#64748b;width:40%;">Payee</td>
        <td style="padding:10px 12px;border:1px solid #e2e8f0;font-size:14px;color:#1e293b;">${v("system_owner_payment_address_name")}</td>
      </tr>
      <tr>
        <td style="padding:10px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#64748b;">Payment Method</td>
        <td style="padding:10px 12px;border:1px solid #e2e8f0;font-size:14px;color:#1e293b;">${v("Payment Method")}</td>
      </tr>
      <tr style="background-color:#f8fafc;">
        <td style="padding:10px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#64748b;">Address</td>
        <td style="padding:10px 12px;border:1px solid #e2e8f0;font-size:14px;color:#1e293b;">${v("system_owner_payment_address")}</td>
      </tr>
      <tr>
        <td style="padding:10px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#64748b;">Address 2</td>
        <td style="padding:10px 12px;border:1px solid #e2e8f0;font-size:14px;color:#1e293b;">${v("system_owner_payment_address2")}</td>
      </tr>
      <tr style="background-color:#f8fafc;">
        <td style="padding:10px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#64748b;">City, State, Zip</td>
        <td style="padding:10px 12px;border:1px solid #e2e8f0;font-size:14px;color:#1e293b;">${v("system_owner_payment_city")}, ${v("system_owner_payment_state")} ${v("system_owner_payment_zip")}</td>
      </tr>
    </table>
  </td>
</tr>`;
}

function updateRequestBlock(v: (key: string) => string): string {
  return `
<tr>
  <td style="padding:0 32px 20px 32px;">
    <div style="font-size:13px;color:#64748b;line-height:1.6;">
      Please complete <a href="#" style="color:#2563eb;text-decoration:underline;">this request form</a> if the payee or mailing address needs to be updated. The deadline to update is <strong>${v("Update Request Deadline")}</strong>.
    </div>
    <div style="font-size:13px;color:#64748b;margin-top:4px;">The answer to the first question is your unique ID number: <strong>${v("ID")}</strong></div>
  </td>
</tr>`;
}

function systemDetailsBlock(v: (key: string) => string, sizeField: string): string {
  return `
<!-- System Details -->
<tr>
  <td style="padding:0 32px 20px 32px;">
    <div style="font-size:14px;font-weight:600;color:#1e3a5f;margin-bottom:8px;">System Details</div>
    <div style="font-size:14px;color:#475569;margin-bottom:4px;">This payment is payment number <strong>${v("Payment Number")}</strong> for your <strong>${v(sizeField)} kW AC</strong> project: <strong>${v("System_Name")}</strong>, located at:</div>
    <div style="font-size:14px;color:#1e293b;font-weight:500;margin-top:4px;">${v("system_address")}<br/>${v("system_city")}, IL ${v("system_zip")}</div>
    <div style="font-size:12px;color:#94a3b8;margin-top:6px;font-style:italic;">This is not where your check is being mailed &mdash; that is in the Payment Address &amp; Method table above.</div>
  </td>
</tr>`;
}

function contractValueTable(v: (key: string) => string): string {
  return `
<tr>
  <td style="padding:0 32px 20px 32px;">
    <div style="font-size:14px;font-weight:600;color:#1e3a5f;margin-bottom:8px;">Total Contract Value</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr style="background-color:#f8fafc;">
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#64748b;">Contracted SRECs</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#64748b;text-align:right;">SREC Price</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#64748b;text-align:right;">Total Contract Value</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;">${v("SRECs")}</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">${v("REC Price")}</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;font-weight:600;">${v("Total Payment")}</td>
      </tr>
    </table>
  </td>
</tr>`;
}

function whyThisEmailBlock(): string {
  return `
<!-- Why this email -->
<tr>
  <td style="padding:0 32px 24px 32px;">
    <div style="font-size:14px;font-weight:600;color:#1e3a5f;margin-bottom:8px;">Why are you receiving this email?</div>
    <div style="font-size:14px;color:#475569;line-height:1.6;">This is a payment to you for your Illinois Shines SREC Incentive contract. As part of the contract you are selling Carbon Solutions your SRECs over 15 years (generated based on your solar PV system's production). For a refresher on what an SREC is, please see <a href="https://www.carbonsolutionsgroup.com" style="color:#2563eb;text-decoration:underline;">our website</a>. If you have any questions, please don&rsquo;t hesitate to reach out &mdash; but please be aware this is a high volume period for our team.</div>
  </td>
</tr>`;
}

function footerBlock(): string {
  return `
<!-- Footer -->
<tr>
  <td style="background-color:#f8fafc;padding:20px 32px;border-top:1px solid #e2e8f0;">
    <div style="font-size:13px;color:#64748b;line-height:1.5;">
      Best regards,<br/>
      <strong style="color:#1e3a5f;">The CSG SREC Team</strong>
    </div>
    <div style="margin-top:12px;">
      <a href="https://www.carbonsolutionsgroup.com" style="font-size:13px;color:#2563eb;text-decoration:underline;">www.carbonsolutionsgroup.com</a><br/>
      <a href="mailto:SREC@carbonsolutionsgroup.com" style="font-size:13px;color:#2563eb;text-decoration:none;">SREC@carbonsolutionsgroup.com</a><br/>
      <span style="font-size:13px;color:#64748b;">1-888-237-SREC (7732)</span><br/>
      <a href="#" style="font-size:13px;color:#2563eb;text-decoration:underline;">Schedule A Call</a>
    </div>
  </td>
</tr>`;
}

/* ------------------------------------------------------------------ */
/*  Template 1: First Payment (full fee breakdown)                      */
/* ------------------------------------------------------------------ */

function buildFirstPaymentHtml(v: (key: string) => string, values: Record<string, string>, useRawPlaceholders: boolean): string {
  const additionalFeeRow =
    useRawPlaceholders || values["Additional Fee"]
      ? `<tr>
            <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;">Additional fee description | Amount</td>
            <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">${v("Additional Fee")}</td>
            <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">${v("ADfee")}</td>
          </tr>`
      : "";

  const additionalCollateralRow =
    useRawPlaceholders || values["Additional Percent"]
      ? `<tr>
            <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;">Additional collateral Percentage | Amount</td>
            <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">${v("Additional Percent")}</td>
            <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">${v("Additional")}</td>
          </tr>`
      : "";

  const ccAuthRow =
    useRawPlaceholders || values["CC Auth AdCo"]
      ? `<tr>
            <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;">&dagger;5% Additional Collateral Selected on CC Auth Form | Amount</td>
            <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">${v("CC Auth AdCo")}</td>
            <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">${v("CC Auth AdCo Amount")}</td>
          </tr>`
      : "";

  const fiveIfPaidRow =
    useRawPlaceholders || values["Five if Paid"]
      ? `<tr>
            <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;">**5% Collateral Paid Upfront | Amount</td>
            <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">5.00% of Projected Contract Value Paid Upfront</td>
            <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">${v("Five if Paid")}</td>
          </tr>`
      : "";

  return [
    OUTER_START,
    headerBlock(),
    // Greeting
    `<tr>
  <td style="padding:28px 32px 0 32px;">
    <div style="font-size:15px;color:#475569;line-height:1.6;">Dear ${v("system_owner_payment_address_name")},</div>
    <div style="font-size:15px;color:#475569;line-height:1.6;margin-top:12px;">This email includes information regarding your upcoming SREC payment. We appreciate your patience as we processed the initial aspect of your incentive payment. We look forward to being your partner for the duration of the 15 year contract.</div>
  </td>
</tr>`,
    // Payment highlight
    `<tr>
  <td style="padding:20px 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#eff6ff;border-radius:8px;border:1px solid #bfdbfe;">
      <tr>
        <td style="padding:20px 24px;">
          <div style="font-size:13px;font-weight:600;color:#1e40af;text-transform:uppercase;letter-spacing:0.5px;">Your Payment</div>
          <div style="font-size:32px;font-weight:700;color:#1e3a5f;margin-top:4px;">${v("This Payment")}</div>
          <div style="font-size:14px;color:#64748b;margin-top:8px;">Will be sent by <strong>${v("Payment Send By Date")}</strong> and should arrive within 5&ndash;14 business days.</div>
        </td>
      </tr>
    </table>
  </td>
</tr>`,
    paymentAddressTable(v),
    updateRequestBlock(v),
    // System Details (first payment uses Inverter_Size_kW_AC_Part_2)
    `<tr>
  <td style="padding:0 32px 20px 32px;">
    <div style="font-size:14px;font-weight:600;color:#1e3a5f;margin-bottom:8px;">System Details</div>
    <div style="font-size:14px;color:#475569;margin-bottom:4px;">This payment is for your <strong>${v("Inverter_Size_kW_AC_Part_2")} kW AC</strong> project: <strong>${v("System_Name")}</strong>, located at:</div>
    <div style="font-size:14px;color:#1e293b;font-weight:500;margin-top:4px;">${v("system_address")}<br/>${v("system_city")}, IL ${v("system_zip")}</div>
    <div style="font-size:12px;color:#94a3b8;margin-top:6px;font-style:italic;">This is not where your check is being mailed &mdash; that is in the Payment Address &amp; Method table above.</div>
  </td>
</tr>`,
    // Payment Calculation (full breakdown)
    `<tr>
  <td style="padding:0 32px 20px 32px;">
    <div style="font-size:14px;font-weight:600;color:#1e3a5f;margin-bottom:8px;">Payment Calculation</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:12px;">
      <tr style="background-color:#f8fafc;">
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#64748b;">Contracted SRECs</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#64748b;text-align:right;">SREC Price</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#64748b;text-align:right;">Total Contract Value</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;">${v("SRECs")}</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">${v("REC Price")}</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;font-weight:600;">${v("Total Payment")}</td>
      </tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr style="background-color:#f8fafc;">
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#64748b;">Description</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#64748b;text-align:right;">Rate</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#64748b;text-align:right;">Amount</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;">Total Contract Value</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">${v("SRECs")} x ${v("REC Price")}</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">${v("Total Payment")}</td>
      </tr>
      <tr style="background-color:#f8fafc;">
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;">CSG Fee Percentage, Amount</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">${v("CSG Fee %")}</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">${v("Fee Amount")}</td>
      </tr>
      ${additionalFeeRow}
      ${additionalCollateralRow}
      ${ccAuthRow}
      <tr style="background-color:#f8fafc;">
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;">5% Utility Held Collateral | Amount</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">5.00%</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">${v("Five")}</td>
      </tr>
      ${fiveIfPaidRow}
      <tr style="background-color:#eff6ff;">
        <td style="padding:10px 12px;border:1px solid #bfdbfe;font-size:14px;font-weight:700;color:#1e3a5f;">Your Payment</td>
        <td style="padding:10px 12px;border:1px solid #bfdbfe;font-size:14px;color:#64748b;text-align:right;">Payment less fees and collateral</td>
        <td style="padding:10px 12px;border:1px solid #bfdbfe;font-size:16px;font-weight:700;color:#1e3a5f;text-align:right;">${v("This Payment")}</td>
      </tr>
    </table>
    <div style="font-size:12px;color:#94a3b8;margin-top:10px;line-height:1.5;">
      *To calculate your payment, take the total contract value on the top line above, subtract collateral and fees from the subsequent rows, and add** Collateral Paid Upfront, if any.<br/>
      &dagger;5% Additional Collateral Selected on CC Auth Form: this refers to the selection on the CC Authorization Form to withhold 5% additional collateral instead of agreeing to provide an updated payment method on file for Collateral Drawdowns.<br/>
    </div>
  </td>
</tr>`,
    contractTransferWarning(),
    whyThisEmailBlock(),
    footerBlock(),
    OUTER_END,
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/*  Template 2: Quarterly 5% (20% upfront, payments 2–17)               */
/* ------------------------------------------------------------------ */

function buildQuarterly5PctHtml(v: (key: string) => string): string {
  return [
    OUTER_START,
    headerBlock(),
    // Greeting
    `<tr>
  <td style="padding:28px 32px 0 32px;">
    <div style="font-size:15px;color:#475569;line-height:1.6;">Dear ${v("system_owner_payment_address_name")},</div>
    <div style="font-size:15px;color:#475569;line-height:1.6;margin-top:12px;">This email includes information regarding your upcoming SREC payment. Please review the payment address and payee listed in the &ldquo;Payment Address and Method&rdquo; table below.</div>
  </td>
</tr>`,
    // Contract transfer warning — prominent position for quarterly
    `<tr><td style="padding:20px 32px 0 32px;">`,
    `</td></tr>`,
    contractTransferWarning(),
    // Payment highlight
    `<tr>
  <td style="padding:0 32px 20px 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#eff6ff;border-radius:8px;border:1px solid #bfdbfe;">
      <tr>
        <td style="padding:20px 24px;">
          <div style="font-size:13px;font-weight:600;color:#1e40af;text-transform:uppercase;letter-spacing:0.5px;">Your Payment</div>
          <div style="font-size:32px;font-weight:700;color:#1e3a5f;margin-top:4px;">${v("This Payment")}</div>
          <div style="font-size:14px;color:#64748b;margin-top:8px;">Will be sent by <strong>${v("Payment Send By Date")}</strong> and should arrive within 5&ndash;14 business days. Check payments are mailed from our processor in Arizona.</div>
        </td>
      </tr>
    </table>
  </td>
</tr>`,
    paymentAddressTable(v),
    updateRequestBlock(v),
    systemDetailsBlock(v, "PartII_AC_Size_kw"),
    // Subsequent Payment Info — 5%
    `<tr>
  <td style="padding:0 32px 20px 32px;">
    <div style="font-size:14px;font-weight:600;color:#1e3a5f;margin-bottom:8px;">Subsequent Payments &mdash; 16 Quarterly Payments of 5% each</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:16px;">
      <tr style="background-color:#f8fafc;">
        <td style="padding:10px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#64748b;">5% of Contract Value</td>
        <td style="padding:10px 12px;border:1px solid #e2e8f0;font-size:16px;font-weight:700;color:#1e3a5f;text-align:right;">${v("Five")}</td>
      </tr>
    </table>
  </td>
</tr>`,
    contractValueTable(v),
    // Quarterly schedule
    `<tr>
  <td style="padding:0 32px 24px 32px;">
    <div style="font-size:14px;font-weight:600;color:#1e3a5f;margin-bottom:8px;">Subsequent Payment Schedule</div>
    <div style="font-size:14px;color:#475569;margin-bottom:10px;">Quarterly Payment Schedule for payments 2 through 17:</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;color:#1e293b;background-color:#f8fafc;">May 15th</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;color:#1e293b;">August 15th</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;color:#1e293b;background-color:#f8fafc;">November 15th</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;color:#1e293b;">February 15th</td>
      </tr>
    </table>
  </td>
</tr>`,
    whyThisEmailBlock(),
    // Repeat update request at bottom
    `<tr>
  <td style="padding:0 32px 24px 32px;">
    <div style="font-size:13px;color:#64748b;line-height:1.6;">
      Again, please complete <a href="#" style="color:#2563eb;text-decoration:underline;">this request form</a> if the payee or mailing address needs to be updated.<br/>
      The answer to the first question is your unique ID number: <strong>${v("ID")}</strong>
    </div>
  </td>
</tr>`,
    footerBlock(),
    OUTER_END,
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/*  Template 3: Quarterly 3.54% (15% upfront, payments 2–25)            */
/* ------------------------------------------------------------------ */

function buildQuarterly354PctHtml(v: (key: string) => string): string {
  return [
    OUTER_START,
    headerBlock(),
    // Greeting
    `<tr>
  <td style="padding:28px 32px 0 32px;">
    <div style="font-size:15px;color:#475569;line-height:1.6;">Dear ${v("system_owner_payment_address_name")},</div>
    <div style="font-size:15px;color:#475569;line-height:1.6;margin-top:12px;">This email includes information regarding your upcoming SREC payment. Please do not hesitate to contact us should you have any concerns regarding your PV System or the SREC contract.</div>
  </td>
</tr>`,
    // Contract transfer warning — prominent position
    `<tr><td style="padding:20px 32px 0 32px;">`,
    `</td></tr>`,
    contractTransferWarning(),
    // Payment highlight
    `<tr>
  <td style="padding:0 32px 20px 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#eff6ff;border-radius:8px;border:1px solid #bfdbfe;">
      <tr>
        <td style="padding:20px 24px;">
          <div style="font-size:13px;font-weight:600;color:#1e40af;text-transform:uppercase;letter-spacing:0.5px;">Your Payment</div>
          <div style="font-size:32px;font-weight:700;color:#1e3a5f;margin-top:4px;">${v("This Payment")}</div>
          <div style="font-size:14px;color:#64748b;margin-top:8px;">Will be sent by <strong>${v("Payment Send By Date")}</strong> and should arrive within 5&ndash;14 business days. Check payments are mailed from our processor in Arizona.</div>
        </td>
      </tr>
    </table>
  </td>
</tr>`,
    paymentAddressTable(v),
    updateRequestBlock(v),
    systemDetailsBlock(v, "PartII_AC_Size_kw"),
    // Subsequent Payment Info — 3.54%
    `<tr>
  <td style="padding:0 32px 20px 32px;">
    <div style="font-size:14px;font-weight:600;color:#1e3a5f;margin-bottom:8px;">Subsequent Payments &mdash; 24 Quarterly Payments of 3.54% each</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:16px;">
      <tr style="background-color:#f8fafc;">
        <td style="padding:10px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#64748b;">3.54% of Contract Value</td>
        <td style="padding:10px 12px;border:1px solid #e2e8f0;font-size:16px;font-weight:700;color:#1e3a5f;text-align:right;">${v("threepointfivefour")}</td>
      </tr>
    </table>
  </td>
</tr>`,
    contractValueTable(v),
    // Quarterly schedule
    `<tr>
  <td style="padding:0 32px 24px 32px;">
    <div style="font-size:14px;font-weight:600;color:#1e3a5f;margin-bottom:8px;">Subsequent Payment Schedule</div>
    <div style="font-size:14px;color:#475569;margin-bottom:10px;">Quarterly Payment Schedule for payments 2 through 25:</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;color:#1e293b;background-color:#f8fafc;">May 15th</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;color:#1e293b;">August 15th</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;color:#1e293b;background-color:#f8fafc;">November 15th</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;color:#1e293b;">February 15th</td>
      </tr>
    </table>
  </td>
</tr>`,
    whyThisEmailBlock(),
    // Repeat update request at bottom
    `<tr>
  <td style="padding:0 32px 24px 32px;">
    <div style="font-size:13px;color:#64748b;line-height:1.6;">
      Please complete <a href="#" style="color:#2563eb;text-decoration:underline;">this request form</a> if the payee or mailing address needs to be updated.<br/>
      The answer to the first question is your unique ID number: <strong>${v("ID")}</strong>
    </div>
  </td>
</tr>`,
    footerBlock(),
    OUTER_END,
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/*  Shared: 15% first-payment fee breakdown table                       */
/* ------------------------------------------------------------------ */

function fifteenPercentFeeBreakdown(
  v: (key: string) => string,
  values: Record<string, string>,
  useRawPlaceholders: boolean,
  opts: { labelPrefix: string; resultLabel: string },
): string {
  const additionalFeeRow =
    useRawPlaceholders || values["Additional Fee"]
      ? `<tr>
            <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;">Additional fee description | Amount</td>
            <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">${v("Additional Fee")}</td>
            <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">${v("ADfee")}</td>
          </tr>`
      : "";

  const additionalCollateralRow =
    useRawPlaceholders || values["Additional Percent"]
      ? `<tr>
            <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;">Additional collateral Percentage | Amount</td>
            <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">${v("Additional Percent")}</td>
            <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">${v("Additional")}</td>
          </tr>`
      : "";

  const ccAuthRow =
    useRawPlaceholders || values["CC Auth AdCo"]
      ? `<tr>
            <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;">&dagger;5% Additional Collateral Selected on CC Auth Form | Amount</td>
            <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">${v("CC Auth AdCo")}</td>
            <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">${v("CC Auth AdCo Amount")}</td>
          </tr>`
      : "";

  const fiveIfPaidRow =
    useRawPlaceholders || values["Five if Paid"]
      ? `<tr>
            <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;">*5% Collateral Paid Upfront | Amount</td>
            <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">5.00% of Projected Contract Value Paid Upfront</td>
            <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">${v("Five if Paid")}</td>
          </tr>`
      : "";

  return `
<tr>
  <td style="padding:0 32px 20px 32px;">
    <div style="font-size:14px;font-weight:600;color:#1e3a5f;margin-bottom:8px;">${opts.labelPrefix} &mdash; 15% of Contract Value minus CSG Fee and Collateral</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr style="background-color:#f8fafc;">
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#64748b;">Description</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#64748b;text-align:right;">Rate</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#64748b;text-align:right;">Amount</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;">Total Contract Value</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">${v("SRECs")} x ${v("REC Price")}</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">${v("Total Payment")}</td>
      </tr>
      <tr style="background-color:#f8fafc;">
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;">First Payment before Fees</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">15% of Contract Value</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">${v("Fifteen")}</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;">CSG Fee Percentage, Amount</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">${v("CSG Fee %")} of Contract Value</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">${v("Fee Amount")}</td>
      </tr>
      ${ccAuthRow}
      ${additionalCollateralRow}
      ${additionalFeeRow}
      <tr style="background-color:#f8fafc;">
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;">5% Utility Held Collateral | Amount</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">5% of Contract Value</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;text-align:right;">${v("Five")}</td>
      </tr>
      ${fiveIfPaidRow}
      <tr style="background-color:#eff6ff;">
        <td style="padding:10px 12px;border:1px solid #bfdbfe;font-size:14px;font-weight:700;color:#1e3a5f;">${opts.resultLabel}</td>
        <td style="padding:10px 12px;border:1px solid #bfdbfe;font-size:14px;color:#64748b;text-align:right;">Payment less fees and collateral</td>
        <td style="padding:10px 12px;border:1px solid #bfdbfe;font-size:16px;font-weight:700;color:#1e3a5f;text-align:right;">${v("This Payment")}</td>
      </tr>
    </table>
    <div style="font-size:12px;color:#94a3b8;margin-top:10px;line-height:1.5;">
      *To calculate your payment, take the &ldquo;First Payment before Fees&rdquo; on the 2nd line above, subtract collateral and fees from the subsequent rows, and add Collateral Paid Upfront, if any.<br/>
      &dagger;5% Additional Collateral Selected on CC Auth Form: this refers to the selection on the CC Authorization Form to withhold 5% additional collateral instead of agreeing to provide an updated payment method on file for Collateral Drawdowns in the event that they occur.
    </div>
  </td>
</tr>`;
}

function quarterlySchedule354(v: (key: string) => string): string {
  return `
<tr>
  <td style="padding:0 32px 20px 32px;">
    <div style="font-size:14px;font-weight:600;color:#1e3a5f;margin-bottom:8px;">Subsequent Payments &mdash; 24 Quarterly Payments of 3.54% each</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:16px;">
      <tr style="background-color:#f8fafc;">
        <td style="padding:10px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#64748b;">3.54% of Contract Value</td>
        <td style="padding:10px 12px;border:1px solid #e2e8f0;font-size:16px;font-weight:700;color:#1e3a5f;text-align:right;">${v("threepointfivefour")}</td>
      </tr>
    </table>
  </td>
</tr>
<tr>
  <td style="padding:0 32px 24px 32px;">
    <div style="font-size:14px;font-weight:600;color:#1e3a5f;margin-bottom:8px;">Subsequent Payment Schedule</div>
    <div style="font-size:14px;color:#475569;margin-bottom:10px;">Quarterly Payment Schedule for payments 2 through 25:</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;color:#1e293b;background-color:#f8fafc;">May 15th</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;color:#1e293b;">August 15th</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;color:#1e293b;background-color:#f8fafc;">November 15th</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:14px;color:#1e293b;">February 15th</td>
      </tr>
    </table>
  </td>
</tr>`;
}

/* ------------------------------------------------------------------ */
/*  Template 4: First Payment — 15% upfront + 3.54% quarterly          */
/* ------------------------------------------------------------------ */

function buildFirstPayment354PctHtml(
  v: (key: string) => string,
  values: Record<string, string>,
  useRawPlaceholders: boolean,
): string {
  return [
    OUTER_START,
    headerBlock(),
    `<tr>
  <td style="padding:28px 32px 0 32px;">
    <div style="font-size:15px;color:#475569;line-height:1.6;">Dear ${v("system_owner_payment_address_name")},</div>
    <div style="font-size:15px;color:#475569;line-height:1.6;margin-top:12px;">This email includes information regarding your upcoming SREC payment. Please review the payment address and payee listed in the &ldquo;Payment Address and Method&rdquo; table below. We appreciate your patience as we processed the initial aspect of your incentive payment. We look forward to being your partner for the duration of the 15 year contract.</div>
  </td>
</tr>`,
    // Payment highlight
    `<tr>
  <td style="padding:20px 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#eff6ff;border-radius:8px;border:1px solid #bfdbfe;">
      <tr>
        <td style="padding:20px 24px;">
          <div style="font-size:13px;font-weight:600;color:#1e40af;text-transform:uppercase;letter-spacing:0.5px;">Your Payment</div>
          <div style="font-size:32px;font-weight:700;color:#1e3a5f;margin-top:4px;">${v("This Payment")}</div>
          <div style="font-size:14px;color:#64748b;margin-top:8px;">Will be sent by <strong>${v("Payment Send By Date")}</strong> and should arrive within 5&ndash;14 business days.</div>
        </td>
      </tr>
    </table>
  </td>
</tr>`,
    contractTransferWarning(),
    paymentAddressTable(v),
    updateRequestBlock(v),
    // System details
    `<tr>
  <td style="padding:0 32px 20px 32px;">
    <div style="font-size:14px;font-weight:600;color:#1e3a5f;margin-bottom:8px;">System Details</div>
    <div style="font-size:14px;color:#475569;margin-bottom:4px;">This payment is for your <strong>${v("Inverter_Size_kW_AC_Part_2")} kW AC</strong> project: <strong>${v("System_Name")}</strong>, located at:</div>
    <div style="font-size:14px;color:#1e293b;font-weight:500;margin-top:4px;">${v("system_address")} ${v("system_city")}, IL ${v("system_zip")}</div>
  </td>
</tr>`,
    quarterlySchedule354(v),
    contractValueTable(v),
    fifteenPercentFeeBreakdown(v, values, useRawPlaceholders, {
      labelPrefix: "First Payment",
      resultLabel: "Your Payment",
    }),
    whyThisEmailBlock(),
    footerBlock(),
    OUTER_END,
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/*  Template 5: Negative Balance (15% upfront, fees > first payment)    */
/* ------------------------------------------------------------------ */

function buildNegativeBalance354PctHtml(
  v: (key: string) => string,
  values: Record<string, string>,
  useRawPlaceholders: boolean,
): string {
  return [
    OUTER_START,
    headerBlock(),
    // Greeting — reframed for clarity
    `<tr>
  <td style="padding:28px 32px 0 32px;">
    <div style="font-size:15px;color:#475569;line-height:1.6;">Dear ${v("system_owner_payment_address_name")},</div>
    <div style="font-size:15px;color:#475569;line-height:1.6;margin-top:12px;">This email includes information regarding your SREC payment balance. Because fees and collateral are deducted from your first payment, you may not receive a check right away. Below is a summary of how your balance progresses over your first three utility payments.</div>
  </td>
</tr>`,
    // Projected balances — clear, visual breakdown
    `<tr>
  <td style="padding:20px 32px;">
    <div style="font-size:14px;font-weight:600;color:#1e3a5f;margin-bottom:10px;">Projected Payment Balance</div>
    <div style="font-size:14px;color:#475569;line-height:1.6;margin-bottom:14px;">Each quarter the utility sends us a payment for your system&rsquo;s production. Fees and collateral are deducted from the first payment. If the result is negative, the shortfall carries forward and is recovered from subsequent quarterly payments until your balance turns positive.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr style="background-color:#f8fafc;">
        <td style="padding:10px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#64748b;">Utility Payment</td>
        <td style="padding:10px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#64748b;text-align:right;">Your Balance After</td>
      </tr>
      <tr>
        <td style="padding:10px 12px;border:1px solid #e2e8f0;font-size:14px;color:#1e293b;">Payment 1 (fees &amp; collateral deducted)</td>
        <td style="padding:10px 12px;border:1px solid #e2e8f0;font-size:14px;font-weight:600;text-align:right;color:#dc2626;">${v("This Payment")}</td>
      </tr>
      <tr style="background-color:#f8fafc;">
        <td style="padding:10px 12px;border:1px solid #e2e8f0;font-size:14px;color:#1e293b;">Payment 2</td>
        <td style="padding:10px 12px;border:1px solid #e2e8f0;font-size:14px;font-weight:600;text-align:right;">${v("two")}</td>
      </tr>
      <tr>
        <td style="padding:10px 12px;border:1px solid #e2e8f0;font-size:14px;color:#1e293b;">Payment 3</td>
        <td style="padding:10px 12px;border:1px solid #e2e8f0;font-size:14px;font-weight:600;text-align:right;">${v("three")}</td>
      </tr>
    </table>
    <div style="font-size:13px;color:#64748b;margin-top:10px;line-height:1.5;">
      Your first expected check is on <strong>${v("estimated payment date")}</strong>, which corresponds to the <strong>${v("first payment is payment number")}</strong> payment from the utility. Once the balance is positive, you will begin receiving quarterly checks.
    </div>
  </td>
</tr>`,
    // Current balance callout
    `<tr>
  <td style="padding:0 32px 20px 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#fef2f2;border-radius:8px;border:1px solid #fecaca;">
      <tr>
        <td style="padding:20px 24px;">
          <div style="font-size:13px;font-weight:600;color:#991b1b;text-transform:uppercase;letter-spacing:0.5px;">Current Balance</div>
          <div style="font-size:32px;font-weight:700;color:#991b1b;margin-top:4px;">${v("This Payment")}</div>
          <div style="font-size:14px;color:#7f1d1d;margin-top:8px;">This negative balance will be recovered from future quarterly payments. No action is needed from you.</div>
        </td>
      </tr>
    </table>
  </td>
</tr>`,
    contractTransferWarning(),
    paymentAddressTable(v),
    // Update request
    `<tr>
  <td style="padding:0 32px 20px 32px;">
    <div style="font-size:13px;color:#64748b;line-height:1.6;">
      Please complete <a href="#" style="color:#2563eb;text-decoration:underline;">this request form</a> if the payee or mailing address needs to be updated.<br/>
      The answer to the first question is your unique ID number: <strong>${v("ID")}</strong>
    </div>
  </td>
</tr>`,
    // System details
    `<tr>
  <td style="padding:0 32px 20px 32px;">
    <div style="font-size:14px;font-weight:600;color:#1e3a5f;margin-bottom:8px;">System Details</div>
    <div style="font-size:14px;color:#475569;margin-bottom:4px;">This is for your <strong>${v("Inverter_Size_kW_AC_Part_2")} kW AC</strong> project: <strong>${v("System_Name")}</strong>, located at:</div>
    <div style="font-size:14px;color:#1e293b;font-weight:500;margin-top:4px;">${v("system_address")} ${v("system_city")}, IL ${v("system_zip")}</div>
  </td>
</tr>`,
    quarterlySchedule354(v),
    contractValueTable(v),
    fifteenPercentFeeBreakdown(v, values, useRawPlaceholders, {
      labelPrefix: "Payment Breakdown",
      resultLabel: "Your Balance",
    }),
    whyThisEmailBlock(),
    footerBlock(),
    OUTER_END,
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/*  Dispatcher                                                          */
/* ------------------------------------------------------------------ */

function buildEmailHtml(
  values: Record<string, string>,
  useRawPlaceholders: boolean,
  templateType: EmailTemplateType = "first_payment",
): string {
  const v = (key: string): string => {
    if (useRawPlaceholders) return `&lt;&lt;${key}&gt;&gt;`;
    return values[key] ?? "";
  };

  switch (templateType) {
    case "quarterly_5pct":
      return buildQuarterly5PctHtml(v);
    case "quarterly_354pct":
      return buildQuarterly354PctHtml(v);
    case "first_payment_354pct":
      return buildFirstPayment354PctHtml(v, values, useRawPlaceholders);
    case "negative_balance_354pct":
      return buildNegativeBalance354PctHtml(v, values, useRawPlaceholders);
    case "first_payment":
    default:
      return buildFirstPaymentHtml(v, values, useRawPlaceholders);
  }
}

/* ------------------------------------------------------------------ */
/*  Exported helpers                                                    */
/* ------------------------------------------------------------------ */

/** Returns the raw HTML template string with <<placeholder>> tags for YAMM. */
export function getYammHtmlTemplate(templateType: EmailTemplateType = "first_payment"): string {
  return buildEmailHtml({}, true, templateType);
}

/* ------------------------------------------------------------------ */
/*  Preview Dialog                                                      */
/* ------------------------------------------------------------------ */

type AbpPaymentEmailPreviewDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: Array<Record<string, string>>;
  initialIndex: number;
  templateType?: EmailTemplateType;
  onTemplateTypeChange?: (type: EmailTemplateType) => void;
};

export function AbpPaymentEmailPreviewDialog({
  open,
  onOpenChange,
  rows,
  initialIndex,
  templateType: externalTemplateType,
  onTemplateTypeChange,
}: AbpPaymentEmailPreviewDialogProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [showTemplate, setShowTemplate] = useState(false);
  const [internalTemplateType, setInternalTemplateType] = useState<EmailTemplateType>("first_payment");
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const templateType = externalTemplateType ?? internalTemplateType;
  const setTemplateType = onTemplateTypeChange ?? setInternalTemplateType;

  // Reset index when dialog opens with a new initialIndex
  const prevOpenRef = useRef(open);
  if (open && !prevOpenRef.current) {
    if (currentIndex !== initialIndex) {
      setCurrentIndex(initialIndex);
    }
  }
  prevOpenRef.current = open;

  const currentRow = rows[currentIndex] ?? {};

  const html = useMemo(
    () =>
      showTemplate
        ? buildEmailHtml({}, true, templateType)
        : buildEmailHtml(currentRow, false, templateType),
    [currentRow, showTemplate, templateType]
  );

  const handlePrev = useCallback(() => {
    setCurrentIndex((i) => Math.max(0, i - 1));
  }, []);

  const handleNext = useCallback(() => {
    setCurrentIndex((i) => Math.min(rows.length - 1, i + 1));
  }, [rows.length]);

  const handleCopyTemplate = useCallback(async () => {
    try {
      const templateHtml = getYammHtmlTemplate(templateType);
      await navigator.clipboard.writeText(templateHtml);
      toast.success(
        `${EMAIL_TEMPLATE_LABELS[templateType]} template copied to clipboard.`
      );
    } catch {
      toast.error("Failed to copy to clipboard.");
    }
  }, [templateType]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between gap-4">
            <DialogTitle>
              Email Preview
              {!showTemplate && rows.length > 0 && (
                <span className="text-sm font-normal text-slate-500 ml-2">
                  Row {currentIndex + 1} of {rows.length}
                  {currentRow.ID ? ` — ${currentRow.ID}` : ""}
                </span>
              )}
            </DialogTitle>
            <div className="flex items-center gap-2 mr-8">
              <Select
                value={templateType}
                onValueChange={(val) => setTemplateType(val as EmailTemplateType)}
              >
                <SelectTrigger className="w-[240px] h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(EMAIL_TEMPLATE_LABELS) as EmailTemplateType[]).map((key) => (
                    <SelectItem key={key} value={key} className="text-xs">
                      {EMAIL_TEMPLATE_LABELS[key]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowTemplate((s) => !s)}
                title={showTemplate ? "Show preview with data" : "Show template placeholders"}
              >
                {showTemplate ? <Eye className="h-4 w-4 mr-1.5" /> : <EyeOff className="h-4 w-4 mr-1.5" />}
                {showTemplate ? "Data" : "Tags"}
              </Button>
              <Button variant="outline" size="sm" onClick={handleCopyTemplate}>
                <ClipboardCopy className="h-4 w-4 mr-1.5" />
                Copy HTML
              </Button>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-hidden rounded-md border bg-slate-100">
          <iframe
            ref={iframeRef}
            srcDoc={html}
            title="Email preview"
            sandbox="allow-same-origin"
            className="w-full h-full min-h-[500px]"
            style={{ border: "none" }}
          />
        </div>

        {!showTemplate && rows.length > 1 && (
          <div className="flex items-center justify-center gap-3 pt-2">
            <Button variant="outline" size="sm" onClick={handlePrev} disabled={currentIndex === 0}>
              <ChevronLeft className="h-4 w-4 mr-1" />
              Previous
            </Button>
            <span className="text-sm text-slate-500 tabular-nums">
              {currentIndex + 1} / {rows.length}
            </span>
            <Button variant="outline" size="sm" onClick={handleNext} disabled={currentIndex >= rows.length - 1}>
              Next
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
