import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { trpc } from "@/lib/trpc";
import { Copy, ShieldCheck, ShieldOff, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

type SetupState =
  | { step: "idle" }
  | {
      step: "qr";
      qrDataUrl: string;
      secret: string;
      recoveryCodes: string[];
    }
  | { step: "confirm" };

export default function TwoFactorSettings() {
  const statusQuery = trpc.twoFactor.status.useQuery();
  const setupMutation = trpc.twoFactor.setup.useMutation();
  const confirmMutation = trpc.twoFactor.confirmSetup.useMutation();
  const disableMutation = trpc.twoFactor.disable.useMutation();
  const regenMutation = trpc.twoFactor.regenerateRecoveryCodes.useMutation();
  const utils = trpc.useUtils();

  const [setupState, setSetupState] = useState<SetupState>({ step: "idle" });
  const [confirmCode, setConfirmCode] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [regenCode, setRegenCode] = useState("");
  const [showDisable, setShowDisable] = useState(false);
  const [showRegen, setShowRegen] = useState(false);
  const [newRecoveryCodes, setNewRecoveryCodes] = useState<string[] | null>(null);

  const enabled = statusQuery.data?.enabled ?? false;
  const recoveryCount = statusQuery.data?.recoveryCodesRemaining ?? 0;

  const handleStartSetup = async () => {
    try {
      const result = await setupMutation.mutateAsync();
      setSetupState({
        step: "qr",
        qrDataUrl: result.qrDataUrl,
        secret: result.secret,
        recoveryCodes: result.recoveryCodes,
      });
    } catch {
      toast.error("Failed to start 2FA setup");
    }
  };

  const handleConfirm = async () => {
    if (confirmCode.length !== 6) return;
    try {
      const result = await confirmMutation.mutateAsync({ code: confirmCode });
      if (result.success) {
        toast.success("2FA enabled successfully");
        setSetupState({ step: "idle" });
        setConfirmCode("");
        await utils.twoFactor.status.invalidate();
        await utils.auth.me.invalidate();
      } else {
        toast.error(result.error || "Invalid code");
        setConfirmCode("");
      }
    } catch {
      toast.error("Failed to confirm 2FA setup");
    }
  };

  const handleDisable = async () => {
    if (disableCode.length !== 6) return;
    try {
      const result = await disableMutation.mutateAsync({ code: disableCode });
      if (result.success) {
        toast.success("2FA disabled");
        setShowDisable(false);
        setDisableCode("");
        await utils.twoFactor.status.invalidate();
        await utils.auth.me.invalidate();
      } else {
        toast.error(result.error || "Invalid code");
        setDisableCode("");
      }
    } catch {
      toast.error("Failed to disable 2FA");
    }
  };

  const handleRegen = async () => {
    if (regenCode.length !== 6) return;
    try {
      const result = await regenMutation.mutateAsync({ code: regenCode });
      if (result.success) {
        setNewRecoveryCodes(result.recoveryCodes);
        setShowRegen(false);
        setRegenCode("");
        await utils.twoFactor.status.invalidate();
        toast.success("Recovery codes regenerated");
      } else {
        toast.error(result.error || "Invalid code");
        setRegenCode("");
      }
    } catch {
      toast.error("Failed to regenerate recovery codes");
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  };

  // Show recovery codes after setup or regeneration
  const showingCodes =
    setupState.step === "qr"
      ? setupState.recoveryCodes
      : newRecoveryCodes;

  return (
    <div>
      <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-4">
        Two-Factor Authentication
      </h2>
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            {enabled ? (
              <ShieldCheck className="h-4 w-4 text-emerald-600" />
            ) : (
              <ShieldOff className="h-4 w-4 text-slate-400" />
            )}
            {enabled ? "2FA Enabled" : "2FA Disabled"}
          </CardTitle>
          <CardDescription className="text-sm">
            {enabled
              ? `Protect your account with an authenticator app. ${recoveryCount} recovery code${recoveryCount === 1 ? "" : "s"} remaining.`
              : "Add an extra layer of security by requiring a code from your authenticator app."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Not enabled — setup flow */}
          {!enabled && setupState.step === "idle" && (
            <Button onClick={handleStartSetup} disabled={setupMutation.isPending}>
              {setupMutation.isPending ? "Setting up..." : "Enable 2FA"}
            </Button>
          )}

          {/* QR code step */}
          {setupState.step === "qr" && (
            <div className="space-y-4">
              <p className="text-sm text-slate-600 dark:text-slate-300">
                Scan this QR code with your authenticator app (Google
                Authenticator, Authy, etc.):
              </p>
              <div className="flex justify-center">
                <img
                  src={setupState.qrDataUrl}
                  alt="TOTP QR Code"
                  className="w-48 h-48 rounded border"
                />
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                <p className="mb-1">Or enter this key manually:</p>
                <div className="flex items-center gap-2">
                  <code className="bg-slate-100 dark:bg-slate-800 px-2 py-1 rounded font-mono text-xs break-all">
                    {setupState.secret}
                  </code>
                  <button
                    onClick={() => copyToClipboard(setupState.secret)}
                    className="text-slate-500 hover:text-slate-700"
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                  Enter the 6-digit code to confirm:
                </p>
                <div className="flex items-center gap-3">
                  <InputOTP
                    maxLength={6}
                    value={confirmCode}
                    onChange={setConfirmCode}
                    onComplete={handleConfirm}
                  >
                    <InputOTPGroup>
                      <InputOTPSlot index={0} />
                      <InputOTPSlot index={1} />
                      <InputOTPSlot index={2} />
                      <InputOTPSlot index={3} />
                      <InputOTPSlot index={4} />
                      <InputOTPSlot index={5} />
                    </InputOTPGroup>
                  </InputOTP>
                  <Button
                    size="sm"
                    onClick={handleConfirm}
                    disabled={
                      confirmCode.length !== 6 || confirmMutation.isPending
                    }
                  >
                    {confirmMutation.isPending ? "Verifying..." : "Confirm"}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Recovery codes display */}
          {showingCodes && showingCodes.length > 0 && (
            <div className="space-y-2 p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
              <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                Save these recovery codes — you won't see them again!
              </p>
              <div className="grid grid-cols-2 gap-1">
                {showingCodes.map((code, i) => (
                  <code
                    key={i}
                    className="text-xs font-mono bg-white dark:bg-slate-900 px-2 py-1 rounded"
                  >
                    {code}
                  </code>
                ))}
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => copyToClipboard(showingCodes.join("\n"))}
              >
                <Copy className="h-3 w-3 mr-1" />
                Copy All
              </Button>
              {newRecoveryCodes && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setNewRecoveryCodes(null)}
                >
                  Dismiss
                </Button>
              )}
            </div>
          )}

          {/* Enabled — management actions */}
          {enabled && !showDisable && !showRegen && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowRegen(true)}
              >
                <RefreshCw className="h-3 w-3 mr-1" />
                Regenerate Recovery Codes
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setShowDisable(true)}
              >
                Disable 2FA
              </Button>
            </div>
          )}

          {/* Disable confirmation */}
          {showDisable && (
            <div className="space-y-2 p-3 border rounded-lg">
              <p className="text-sm text-slate-600 dark:text-slate-300">
                Enter your current 2FA code to disable:
              </p>
              <div className="flex items-center gap-3">
                <InputOTP
                  maxLength={6}
                  value={disableCode}
                  onChange={setDisableCode}
                  onComplete={handleDisable}
                >
                  <InputOTPGroup>
                    <InputOTPSlot index={0} />
                    <InputOTPSlot index={1} />
                    <InputOTPSlot index={2} />
                    <InputOTPSlot index={3} />
                    <InputOTPSlot index={4} />
                    <InputOTPSlot index={5} />
                  </InputOTPGroup>
                </InputOTP>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={handleDisable}
                  disabled={
                    disableCode.length !== 6 || disableMutation.isPending
                  }
                >
                  {disableMutation.isPending ? "Disabling..." : "Confirm"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setShowDisable(false);
                    setDisableCode("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* Regenerate recovery codes confirmation */}
          {showRegen && (
            <div className="space-y-2 p-3 border rounded-lg">
              <p className="text-sm text-slate-600 dark:text-slate-300">
                Enter your current 2FA code to regenerate recovery codes:
              </p>
              <div className="flex items-center gap-3">
                <InputOTP
                  maxLength={6}
                  value={regenCode}
                  onChange={setRegenCode}
                  onComplete={handleRegen}
                >
                  <InputOTPGroup>
                    <InputOTPSlot index={0} />
                    <InputOTPSlot index={1} />
                    <InputOTPSlot index={2} />
                    <InputOTPSlot index={3} />
                    <InputOTPSlot index={4} />
                    <InputOTPSlot index={5} />
                  </InputOTPGroup>
                </InputOTP>
                <Button
                  size="sm"
                  onClick={handleRegen}
                  disabled={
                    regenCode.length !== 6 || regenMutation.isPending
                  }
                >
                  {regenMutation.isPending ? "Regenerating..." : "Confirm"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setShowRegen(false);
                    setRegenCode("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
