import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { trpc } from "@/lib/trpc";
import { Loader2, ShieldCheck } from "lucide-react";
import { useCallback, useState } from "react";

type TwoFactorGateProps = {
  children: React.ReactNode;
};

export default function TwoFactorGate({ children }: TwoFactorGateProps) {
  const meQuery = trpc.auth.me.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  const verifyMutation = trpc.twoFactor.verify.useMutation();
  const utils = trpc.useUtils();

  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      setError(null);

      const submittedCode = useRecovery ? recoveryCode.trim() : code.trim();
      if (!submittedCode) {
        setError("Enter a code");
        return;
      }

      try {
        const result = await verifyMutation.mutateAsync({ code: submittedCode });
        if (result.success) {
          // Refresh the auth state to pick up the new JWT
          await utils.auth.me.invalidate();
        } else {
          setError(result.error || "Invalid code");
          setCode("");
        }
      } catch {
        setError("Verification failed");
        setCode("");
      }
    },
    [code, recoveryCode, useRecovery, verifyMutation, utils]
  );

  // Loading state
  if (meQuery.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-100">
        <Loader2 className="h-6 w-6 animate-spin text-slate-600" />
      </div>
    );
  }

  // Not logged in or no 2FA pending — pass through
  const user = meQuery.data;
  if (!user || !user.twoFactorPending) {
    return <>{children}</>;
  }

  // 2FA verification required
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 via-white to-slate-100 flex items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <ShieldCheck className="h-5 w-5 text-slate-700" />
          <h1 className="text-lg font-semibold text-slate-900">
            Two-Factor Authentication
          </h1>
        </div>
        <p className="text-sm text-slate-600 mb-4">
          {useRecovery
            ? "Enter one of your recovery codes."
            : "Enter the 6-digit code from your authenticator app."}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          {useRecovery ? (
            <Input
              type="text"
              placeholder="Recovery code"
              value={recoveryCode}
              onChange={(e) => setRecoveryCode(e.target.value)}
              autoFocus
              className="font-mono tracking-wider"
            />
          ) : (
            <div className="flex justify-center">
              <InputOTP
                maxLength={6}
                value={code}
                onChange={(val) => setCode(val)}
                onComplete={() => handleSubmit()}
                autoFocus
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
            </div>
          )}

          {error && <p className="text-xs text-red-600">{error}</p>}

          <Button
            className="w-full"
            type="submit"
            disabled={verifyMutation.isPending}
          >
            {verifyMutation.isPending ? "Verifying..." : "Verify"}
          </Button>

          <button
            type="button"
            className="text-xs text-slate-600 underline underline-offset-2 hover:text-slate-900"
            onClick={() => {
              setUseRecovery(!useRecovery);
              setError(null);
              setCode("");
              setRecoveryCode("");
            }}
          >
            {useRecovery
              ? "Use authenticator app instead"
              : "Use a recovery code"}
          </button>
        </form>
      </div>
    </div>
  );
}
