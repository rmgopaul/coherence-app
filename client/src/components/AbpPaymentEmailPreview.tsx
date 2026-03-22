import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ChevronLeft, ChevronRight, ClipboardCopy, Eye, EyeOff } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const YAMM_FIELD_KEYS = [
  "system_owner_payment_address_name",
  "This Payment",
  "Payment Method",
  "system_owner_payment_address",
  "system_owner_payment_address2",
  "system_owner_payment_city",
  "system_owner_payment_state",
  "system_owner_payment_zip",
  "ID",
  "Inverter_Size_kW_AC_Part_2",
  "System_Name",
  "system_address",
  "system_city",
  "system_zip",
  "SRECs",
  "REC Price",
  "Total Payment",
  "CSG Fee %",
  "Fee Amount",
  "Additional Fee",
  "ADfee",
  "Additional Percent",
  "Additional",
  "CC Auth AdCo",
  "CC Auth AdCo Amount",
  "Five",
  "Five if Paid",
  "Payment Notes",
  "Payment Number",
  "Contract ID",
  "Payment Send By Date",
  "Update Request Deadline",
] as const;

/* ------------------------------------------------------------------ */
/*  HTML email template builder                                        */
/* ------------------------------------------------------------------ */

function buildEmailHtml(values: Record<string, string>, useRawPlaceholders: boolean): string {
  const v = (key: string): string => {
    if (useRawPlaceholders) return `&lt;&lt;${key}&gt;&gt;`;
    return values[key] ?? "";
  };

  // Conditionally show fee rows only when there's a value
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

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f5f9;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">

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
</tr>

<!-- Payment highlight -->
<tr>
  <td style="padding:28px 32px 0 32px;">
    <div style="font-size:15px;color:#475569;line-height:1.6;">Dear ${v("system_owner_payment_address_name")},</div>
    <div style="font-size:15px;color:#475569;line-height:1.6;margin-top:12px;">This email includes information regarding your upcoming SREC payment. We appreciate your patience as we processed the initial aspect of your incentive payment. We look forward to being your partner for the duration of the 15 year contract.</div>
  </td>
</tr>
<tr>
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
</tr>

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
    <div style="font-size:13px;color:#64748b;margin-top:10px;">Please complete <a href="#" style="color:#2563eb;text-decoration:underline;">this request form</a> if the payee or mailing address needs to be updated. The deadline to update is <strong>${v("Update Request Deadline")}</strong>.</div>
    <div style="font-size:13px;color:#64748b;margin-top:4px;">The answer to the first question is your unique ID number: <strong>${v("ID")}</strong></div>
  </td>
</tr>

<!-- System Details -->
<tr>
  <td style="padding:0 32px 20px 32px;">
    <div style="font-size:14px;font-weight:600;color:#1e3a5f;margin-bottom:8px;">System Details</div>
    <div style="font-size:14px;color:#475569;margin-bottom:4px;">This payment is for your <strong>${v("Inverter_Size_kW_AC_Part_2")} kW AC</strong> project: <strong>${v("System_Name")}</strong>, located at:</div>
    <div style="font-size:14px;color:#1e293b;font-weight:500;margin-top:4px;">${v("system_address")}<br/>${v("system_city")}, IL ${v("system_zip")}</div>
    <div style="font-size:12px;color:#94a3b8;margin-top:6px;font-style:italic;">This is not where your check is being mailed &mdash; that is in the Payment Address &amp; Method table above.</div>
  </td>
</tr>

<!-- Payment Calculation -->
<tr>
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
</tr>

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
</tr>

<!-- Why this email -->
<tr>
  <td style="padding:0 32px 24px 32px;">
    <div style="font-size:14px;font-weight:600;color:#1e3a5f;margin-bottom:8px;">Why are you receiving this email?</div>
    <div style="font-size:14px;color:#475569;line-height:1.6;">This is a payment to you for your Illinois Shines SREC Incentive contract. As part of the contract you are selling Carbon Solutions your SRECs over 15 years (generated based on your solar PV system's production). For a refresher on what an SREC is, please see <a href="https://www.carbonsolutionsgroup.com" style="color:#2563eb;text-decoration:underline;">our website</a>. If you have any questions, please don't hesitate to reach out &mdash; but please be aware this is a high volume period for our team.</div>
  </td>
</tr>

<!-- Footer -->
<tr>
  <td style="background-color:#f8fafc;padding:20px 32px;border-top:1px solid #e2e8f0;">
    <div style="font-size:13px;color:#64748b;line-height:1.5;">
      Best regards,<br/>
      <strong style="color:#1e3a5f;">The CSG SREC Team</strong>
    </div>
    <div style="margin-top:12px;">
      <a href="https://www.carbonsolutionsgroup.com" style="font-size:13px;color:#2563eb;text-decoration:underline;">www.carbonsolutionsgroup.com</a>
    </div>
  </td>
</tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/*  Exported helpers                                                    */
/* ------------------------------------------------------------------ */

/** Returns the raw HTML template string with <<placeholder>> tags for YAMM. */
export function getYammHtmlTemplate(): string {
  const placeholderValues: Record<string, string> = {};
  for (const key of YAMM_FIELD_KEYS) {
    placeholderValues[key] = `<<${key}>>`;
  }
  // For the template version, we pass useRawPlaceholders = false but with
  // the values already set to <<key>> so they render literally.
  return buildEmailHtml(placeholderValues, false);
}

/* ------------------------------------------------------------------ */
/*  Preview Dialog                                                      */
/* ------------------------------------------------------------------ */

type AbpPaymentEmailPreviewDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: Array<Record<string, string>>;
  initialIndex: number;
};

export function AbpPaymentEmailPreviewDialog({
  open,
  onOpenChange,
  rows,
  initialIndex,
}: AbpPaymentEmailPreviewDialogProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [showTemplate, setShowTemplate] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Reset index when dialog opens with a new initialIndex
  const prevOpenRef = useRef(open);
  if (open && !prevOpenRef.current) {
    // Dialog just opened — synchronize index
    if (currentIndex !== initialIndex) {
      setCurrentIndex(initialIndex);
    }
  }
  prevOpenRef.current = open;

  const currentRow = rows[currentIndex] ?? {};

  const html = useMemo(
    () => (showTemplate ? buildEmailHtml({}, true) : buildEmailHtml(currentRow, false)),
    [currentRow, showTemplate]
  );

  const handlePrev = useCallback(() => {
    setCurrentIndex((i) => Math.max(0, i - 1));
  }, []);

  const handleNext = useCallback(() => {
    setCurrentIndex((i) => Math.min(rows.length - 1, i + 1));
  }, [rows.length]);

  const handleCopyTemplate = useCallback(async () => {
    try {
      const templateHtml = getYammHtmlTemplate();
      await navigator.clipboard.writeText(templateHtml);
      toast.success("HTML template copied to clipboard. Paste it into your YAMM Google Sheet template cell.");
    } catch {
      toast.error("Failed to copy to clipboard.");
    }
  }, []);

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
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowTemplate((s) => !s)}
                title={showTemplate ? "Show preview with data" : "Show template placeholders"}
              >
                {showTemplate ? <Eye className="h-4 w-4 mr-1.5" /> : <EyeOff className="h-4 w-4 mr-1.5" />}
                {showTemplate ? "Data view" : "Template view"}
              </Button>
              <Button variant="outline" size="sm" onClick={handleCopyTemplate}>
                <ClipboardCopy className="h-4 w-4 mr-1.5" />
                Copy HTML Template
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
