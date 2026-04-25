import { useCallback, useEffect, useState } from "react";

export type SolarRecUser = {
  id: number;
  email: string;
  isScopeAdmin: boolean;
  name: string | null;
  role: "owner" | "admin" | "operator" | "viewer";
  avatarUrl: string | null;
};

type AuthState = {
  loading: boolean;
  authenticated: boolean;
  user: SolarRecUser | null;
};

export function useSolarRecAuth() {
  const [state, setState] = useState<AuthState>({
    loading: true,
    authenticated: false,
    user: null,
  });

  const checkAuth = useCallback(async () => {
    try {
      const res = await fetch("/solar-rec/api/auth/status", {
        credentials: "include",
      });
      if (!res.ok) {
        setState({ loading: false, authenticated: false, user: null });
        return;
      }
      const data = await res.json();
      setState({
        loading: false,
        authenticated: data.authenticated === true,
        user: data.user ?? null,
      });
    } catch {
      setState({ loading: false, authenticated: false, user: null });
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const logout = useCallback(async () => {
    await fetch("/solar-rec/api/auth/logout", {
      method: "POST",
      credentials: "include",
    });
    setState({ loading: false, authenticated: false, user: null });
  }, []);

  const loginWithGoogle = useCallback(() => {
    window.location.href = "/solar-rec/api/auth/google";
  }, []);

  const isAdmin =
    state.user?.isScopeAdmin === true ||
    state.user?.role === "owner" ||
    state.user?.role === "admin";
  const isOperator = isAdmin || state.user?.role === "operator";

  return {
    ...state,
    logout,
    loginWithGoogle,
    checkAuth,
    isAdmin,
    isOperator,
  };
}
