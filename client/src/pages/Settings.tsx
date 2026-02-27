import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { Activity, Calendar, CheckSquare, Mail, MessageSquare, StickyNote, Trash2, ArrowLeft, Plus } from "lucide-react";
import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

const OPENAI_MODELS = [
  "gpt-5",
  "gpt-5-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4o",
  "gpt-4o-mini",
];

const TODOIST_DEFAULT_OPTIONS = [
  { value: "all", label: "All open tasks" },
  { value: "#Inbox", label: "Inbox" },
  { value: "today", label: "Today" },
  { value: "upcoming", label: "Upcoming (7 days)" },
];

const HABIT_COLOR_OPTIONS = [
  "slate",
  "emerald",
  "blue",
  "violet",
  "rose",
  "amber",
];

const SUPPLEMENT_UNITS = ["capsule", "tablet", "mg", "mcg", "g", "ml", "drop", "scoop", "other"] as const;

type SupplementEditorState = {
  name: string;
  brand: string;
  dose: string;
  doseUnit: (typeof SUPPLEMENT_UNITS)[number];
  dosePerUnit: string;
  timing: "am" | "pm";
  productUrl: string;
  pricePerBottle: string;
  quantityPerBottle: string;
  isLocked: boolean;
};

export default function Settings() {
  const { user, loading } = useAuth();
  const [, setLocation] = useLocation();
  const [openaiKey, setOpenaiKey] = useState("");
  const [openaiModel, setOpenaiModel] = useState("gpt-4.1");
  const [todoistToken, setTodoistToken] = useState("");
  const [todoistDefaultFilter, setTodoistDefaultFilter] = useState("all");
  const [googleClientId, setGoogleClientId] = useState("");
  const [googleClientSecret, setGoogleClientSecret] = useState("");
  const [microsoftClientId, setMicrosoftClientId] = useState("");
  const [microsoftClientSecret, setMicrosoftClientSecret] = useState("");
  const [whoopClientId, setWhoopClientId] = useState("");
  const [whoopClientSecret, setWhoopClientSecret] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [newHabitName, setNewHabitName] = useState("");
  const [newHabitColor, setNewHabitColor] = useState("slate");
  const [newSupplementName, setNewSupplementName] = useState("");
  const [newSupplementBrand, setNewSupplementBrand] = useState("");
  const [newSupplementDose, setNewSupplementDose] = useState("");
  const [newSupplementDoseUnit, setNewSupplementDoseUnit] =
    useState<(typeof SUPPLEMENT_UNITS)[number]>("capsule");
  const [newSupplementDosePerUnit, setNewSupplementDosePerUnit] = useState("");
  const [newSupplementTiming, setNewSupplementTiming] = useState<"am" | "pm">("am");
  const [newSupplementProductUrl, setNewSupplementProductUrl] = useState("");
  const [newSupplementPricePerBottle, setNewSupplementPricePerBottle] = useState("");
  const [newSupplementQuantityPerBottle, setNewSupplementQuantityPerBottle] = useState("");
  const [supplementDrafts, setSupplementDrafts] = useState<Record<string, SupplementEditorState>>({});
  
  const { data: integrations, isLoading, refetch } = trpc.integrations.list.useQuery(undefined, {
    enabled: !!user,
  });
  const { data: preferences, refetch: refetchPreferences } = trpc.preferences.get.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });
  const todoistIntegration = integrations?.find((i) => i.provider === "todoist");
  const hasTodoistConnected = Boolean(todoistIntegration);

  const { data: todoistProjects } = trpc.todoist.getProjects.useQuery(undefined, {
    enabled: !!user && hasTodoistConnected,
    retry: false,
  });
  
  const { data: googleCreds } = trpc.oauthCreds.get.useQuery(
    { provider: "google" },
    { enabled: !!user }
  );
  
  const { data: microsoftCreds } = trpc.oauthCreds.get.useQuery(
    { provider: "microsoft" },
    { enabled: !!user }
  );

  const { data: whoopCreds } = trpc.oauthCreds.get.useQuery(
    { provider: "whoop" },
    { enabled: !!user }
  );

  const dumpAllDataQuery = trpc.dataExport.dumpAll.useQuery(undefined, {
    enabled: false,
    retry: false,
  });
  const dumpStructuredCsvQuery = trpc.dataExport.dumpStructuredCsv.useQuery(undefined, {
    enabled: false,
    retry: false,
  });

  const { data: habitDefinitions, refetch: refetchHabits } = trpc.habits.listDefinitions.useQuery(
    undefined,
    { enabled: !!user }
  );

  const { data: supplementDefinitions, refetch: refetchSupplementDefinitions } =
    trpc.supplements.listDefinitions.useQuery(undefined, {
      enabled: !!user,
      retry: false,
    });
  
  const connectTodoist = trpc.todoist.connect.useMutation({
    onSuccess: () => {
      toast.success("Todoist connected successfully");
      setTodoistToken("");
      refetch();
    },
    onError: (error) => {
      toast.error(`Failed to connect Todoist: ${error.message}`);
    },
  });
  
  const connectOpenAI = trpc.openai.connect.useMutation({
    onSuccess: () => {
      toast.success("OpenAI settings saved successfully");
      setOpenaiKey("");
      refetch();
    },
    onError: (error) => {
      toast.error(`Failed to connect OpenAI: ${error.message}`);
    },
  });
  
  const deleteIntegration = trpc.integrations.delete.useMutation({
    onSuccess: () => {
      toast.success("Integration disconnected");
      refetch();
    },
  });
  
  const saveGoogleCreds = trpc.oauthCreds.save.useMutation({
    onSuccess: () => {
      toast.success("Google credentials saved successfully");
    },
    onError: (error) => {
      toast.error(`Failed to save credentials: ${error.message}`);
    },
  });

  const saveMicrosoftCreds = trpc.oauthCreds.save.useMutation({
    onSuccess: () => {
      toast.success("Microsoft credentials saved successfully");
    },
    onError: (error) => {
      toast.error(`Failed to save credentials: ${error.message}`);
    },
  });

  const saveWhoopCreds = trpc.oauthCreds.save.useMutation({
    onSuccess: () => {
      toast.success("WHOOP credentials saved successfully");
    },
    onError: (error) => {
      toast.error(`Failed to save WHOOP credentials: ${error.message}`);
    },
  });

  const saveTodoistSettings = trpc.todoist.saveSettings.useMutation({
    onSuccess: () => {
      toast.success("Todoist default view saved");
      refetch();
    },
    onError: (error) => {
      toast.error(`Failed to save Todoist settings: ${error.message}`);
    },
  });

  const updatePreferences = trpc.preferences.update.useMutation({
    onSuccess: () => {
      toast.success("Display name saved");
      refetchPreferences();
    },
    onError: (error) => {
      toast.error(`Failed to save display name: ${error.message}`);
    },
  });

  const createSupplementDefinition = trpc.supplements.createDefinition.useMutation({
    onSuccess: () => {
      toast.success("Supplement added");
      setNewSupplementName("");
      setNewSupplementBrand("");
      setNewSupplementDose("");
      setNewSupplementDoseUnit("capsule");
      setNewSupplementDosePerUnit("");
      setNewSupplementTiming("am");
      setNewSupplementProductUrl("");
      setNewSupplementPricePerBottle("");
      setNewSupplementQuantityPerBottle("");
      refetchSupplementDefinitions();
    },
    onError: (error) => {
      toast.error(`Failed to add supplement: ${error.message}`);
    },
  });

  const updateSupplementDefinition = trpc.supplements.updateDefinition.useMutation({
    onSuccess: () => {
      toast.success("Supplement updated");
      refetchSupplementDefinitions();
    },
    onError: (error) => {
      toast.error(`Failed to update supplement: ${error.message}`);
    },
  });

  const deleteSupplementDefinition = trpc.supplements.deleteDefinition.useMutation({
    onSuccess: () => {
      toast.success("Supplement removed");
      refetchSupplementDefinitions();
    },
    onError: (error) => {
      toast.error(`Failed to remove supplement: ${error.message}`);
    },
  });

  const createHabitDefinition = trpc.habits.createDefinition.useMutation({
    onSuccess: () => {
      toast.success("Habit created");
      setNewHabitName("");
      refetchHabits();
    },
    onError: (error) => {
      toast.error(`Failed to create habit: ${error.message}`);
    },
  });

  const deleteHabitDefinition = trpc.habits.deleteDefinition.useMutation({
    onSuccess: () => {
      toast.success("Habit removed");
      refetchHabits();
    },
    onError: (error) => {
      toast.error(`Failed to remove habit: ${error.message}`);
    },
  });

  // Load saved credentials into form
  useEffect(() => {
    if (googleCreds) {
      setGoogleClientId(googleCreds.clientId || "");
      setGoogleClientSecret(googleCreds.clientSecret || "");
    }
  }, [googleCreds]);
  
  useEffect(() => {
    if (microsoftCreds) {
      setMicrosoftClientId(microsoftCreds.clientId || "");
      setMicrosoftClientSecret(microsoftCreds.clientSecret || "");
    }
  }, [microsoftCreds]);

  useEffect(() => {
    if (whoopCreds) {
      setWhoopClientId(whoopCreds.clientId || "");
      setWhoopClientSecret(whoopCreds.clientSecret || "");
    }
  }, [whoopCreds]);

  useEffect(() => {
    setDisplayName(preferences?.displayName || user?.name || "");
  }, [preferences?.displayName, user?.name]);

  useEffect(() => {
    if (!supplementDefinitions) return;
    const nextDrafts: Record<string, SupplementEditorState> = {};
    for (const definition of supplementDefinitions) {
      nextDrafts[definition.id] = {
        name: definition.name ?? "",
        brand: definition.brand ?? "",
        dose: definition.dose ?? "",
        doseUnit: (definition.doseUnit as (typeof SUPPLEMENT_UNITS)[number]) ?? "capsule",
        dosePerUnit: definition.dosePerUnit ?? "",
        timing: (definition.timing as "am" | "pm") ?? "am",
        productUrl: definition.productUrl ?? "",
        pricePerBottle:
          definition.pricePerBottle === null || definition.pricePerBottle === undefined
            ? ""
            : String(definition.pricePerBottle),
        quantityPerBottle:
          definition.quantityPerBottle === null || definition.quantityPerBottle === undefined
            ? ""
            : String(definition.quantityPerBottle),
        isLocked: Boolean(definition.isLocked),
      };
    }
    setSupplementDrafts(nextDrafts);
  }, [supplementDefinitions]);

  useEffect(() => {
    const openaiIntegration = integrations?.find((i) => i.provider === "openai");
    if (!openaiIntegration?.metadata) return;
    try {
      const parsed = JSON.parse(openaiIntegration.metadata);
      if (typeof parsed?.model === "string" && parsed.model.trim()) {
        setOpenaiModel(parsed.model.trim());
      }
    } catch {
      // Ignore malformed metadata and keep default model.
    }
  }, [integrations]);

  useEffect(() => {
    if (!todoistIntegration?.metadata) {
      setTodoistDefaultFilter("all");
      return;
    }
    try {
      const parsed = JSON.parse(todoistIntegration.metadata);
      if (typeof parsed?.defaultFilter === "string" && parsed.defaultFilter.trim()) {
        setTodoistDefaultFilter(parsed.defaultFilter.trim());
      } else {
        setTodoistDefaultFilter("all");
      }
    } catch {
      setTodoistDefaultFilter("all");
    }
  }, [todoistIntegration?.metadata]);
  
  // Handle OAuth callback messages
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const success = params.get('success');
    const error = params.get('error');
    const message = params.get('message');
    
    if (success) {
      toast.success(`${success.charAt(0).toUpperCase() + success.slice(1)} connected successfully!`);
      refetch();
      window.history.replaceState({}, '', '/settings');
    } else if (error) {
      const errorMsg = message ? decodeURIComponent(message) : 'Connection failed';
      toast.error(`${error.charAt(0).toUpperCase() + error.slice(1)} error: ${errorMsg}`);
      window.history.replaceState({}, '', '/settings');
    }
  }, [refetch]);
  
  useEffect(() => {
    if (!loading && !user) {
      setLocation("/");
    }
  }, [loading, user, setLocation]);

  if (loading || isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  const connectedProviders = new Set(integrations?.map((i) => i.provider) || []);

  const handleDisconnect = (integrationId: string) => {
    if (confirm("Are you sure you want to disconnect this integration?")) {
      deleteIntegration.mutate({ id: integrationId });
    }
  };

  const handleSaveOpenAI = () => {
    const hasExistingOpenAI = connectedProviders.has("openai");
    const apiKey = openaiKey.trim();
    if (!hasExistingOpenAI && !apiKey) {
      toast.error("Please enter an API key");
      return;
    }
    connectOpenAI.mutate({
      apiKey: apiKey || undefined,
      model: openaiModel,
    });
  };

  const handleSaveGoogleCreds = () => {
    if (!googleClientId.trim() || !googleClientSecret.trim()) {
      toast.error("Please enter both Client ID and Client Secret");
      return;
    }
    saveGoogleCreds.mutate({
      provider: "google",
      clientId: googleClientId,
      clientSecret: googleClientSecret,
    });
  };

  const handleSaveMicrosoftCreds = () => {
    if (!microsoftClientId.trim() || !microsoftClientSecret.trim()) {
      toast.error("Please enter both Client ID and Client Secret");
      return;
    }
    saveMicrosoftCreds.mutate({
      provider: "microsoft",
      clientId: microsoftClientId,
      clientSecret: microsoftClientSecret,
    });
  };

  const handleSaveWhoopCreds = () => {
    if (!whoopClientId.trim() || !whoopClientSecret.trim()) {
      toast.error("Please enter both WHOOP Client ID and Client Secret");
      return;
    }
    saveWhoopCreds.mutate({
      provider: "whoop",
      clientId: whoopClientId,
      clientSecret: whoopClientSecret,
    });
  };

  const handleConnectTodoist = () => {
    if (!todoistToken.trim()) {
      toast.error("Please enter an API token");
      return;
    }
    connectTodoist.mutate({ apiToken: todoistToken });
  };

  const handleSaveTodoistDefault = () => {
    if (!hasTodoistConnected) {
      toast.error("Connect Todoist first");
      return;
    }
    saveTodoistSettings.mutate({ defaultFilter: todoistDefaultFilter });
  };

  const parseOptionalNumber = (raw: string, label: string): number | null => {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric) || numeric < 0) {
      throw new Error(`${label} must be a valid non-negative number`);
    }
    return numeric;
  };

  const handleSaveDisplayName = () => {
    const trimmed = displayName.trim();
    updatePreferences.mutate({
      displayName: trimmed.length > 0 ? trimmed : null,
    });
  };

  const handleAddSupplementDefinition = () => {
    if (!newSupplementName.trim() || !newSupplementDose.trim()) {
      toast.error("Supplement name and default daily amount are required");
      return;
    }

    try {
      const pricePerBottle = parseOptionalNumber(newSupplementPricePerBottle, "Price per bottle");
      const quantityPerBottle = parseOptionalNumber(
        newSupplementQuantityPerBottle,
        "Quantity per bottle"
      );

      createSupplementDefinition.mutate({
        name: newSupplementName.trim(),
        brand: newSupplementBrand.trim() || undefined,
        dose: newSupplementDose.trim(),
        doseUnit: newSupplementDoseUnit,
        dosePerUnit: newSupplementDosePerUnit.trim() || undefined,
        timing: newSupplementTiming,
        productUrl: newSupplementProductUrl.trim() || undefined,
        pricePerBottle: pricePerBottle ?? undefined,
        quantityPerBottle: quantityPerBottle ?? undefined,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Invalid supplement values");
    }
  };

  const updateSupplementDraftField = (
    definitionId: string,
    field: keyof SupplementEditorState,
    value: string | boolean
  ) => {
    setSupplementDrafts((prev) => {
      const current = prev[definitionId];
      if (!current) return prev;
      return {
        ...prev,
        [definitionId]: {
          ...current,
          [field]: value,
        },
      };
    });
  };

  const handleSaveSupplementDefinition = (definitionId: string) => {
    const draft = supplementDrafts[definitionId];
    if (!draft) return;
    if (!draft.name.trim() || !draft.dose.trim()) {
      toast.error("Supplement name and default daily amount are required");
      return;
    }

    try {
      const pricePerBottle = parseOptionalNumber(draft.pricePerBottle, "Price per bottle");
      const quantityPerBottle = parseOptionalNumber(draft.quantityPerBottle, "Quantity per bottle");

      updateSupplementDefinition.mutate({
        definitionId,
        name: draft.name.trim(),
        brand: draft.brand.trim() || null,
        dose: draft.dose.trim(),
        doseUnit: draft.doseUnit,
        dosePerUnit: draft.dosePerUnit.trim() || null,
        timing: draft.timing,
        productUrl: draft.productUrl.trim() || null,
        pricePerBottle,
        quantityPerBottle,
        isLocked: draft.isLocked,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Invalid supplement values");
    }
  };

  const handleCreateHabit = () => {
    if (!newHabitName.trim()) {
      toast.error("Enter a habit name");
      return;
    }
    createHabitDefinition.mutate({
      name: newHabitName.trim(),
      color: newHabitColor,
    });
  };

  const handleDumpAllData = async () => {
    const result = await dumpAllDataQuery.refetch();
    if (!result.data) {
      toast.error("Failed to dump data");
      return;
    }

    const blob = new Blob([JSON.stringify(result.data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `coherence-data-dump-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.success("Data dump downloaded");
  };

  const handleDumpStructuredCsv = async () => {
    const result = await dumpStructuredCsvQuery.refetch();
    if (!result.data) {
      toast.error("Failed to export structured CSV");
      return;
    }

    const blob = new Blob([result.data.csv], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = result.data.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.success(`Structured CSV downloaded (${result.data.rowCount} metrics)`);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <header className="border-b bg-white/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <Button variant="ghost" onClick={() => setLocation("/dashboard")} className="mb-2">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Dashboard
          </Button>
          <h1 className="text-2xl font-bold text-slate-900">Settings</h1>
          <p className="text-sm text-slate-600">Manage your integrations and preferences</p>
        </div>
      </header>

      <main className="container max-w-4xl mx-auto px-4 py-8">
        <div className="space-y-8">
          <div>
            <h2 className="text-xl font-semibold text-slate-900 mb-4">Data Export</h2>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Dump All Data</CardTitle>
                <CardDescription className="text-sm">
                  Export as JSON or structured CSV (metric rows on the left, dates across columns).
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                <Button onClick={handleDumpAllData} disabled={dumpAllDataQuery.isFetching}>
                  {dumpAllDataQuery.isFetching ? "Preparing export..." : "Download Full Data Dump"}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleDumpStructuredCsv}
                  disabled={dumpStructuredCsvQuery.isFetching}
                >
                  {dumpStructuredCsvQuery.isFetching ? "Preparing CSV..." : "Download Structured CSV"}
                </Button>
              </CardContent>
            </Card>
          </div>

          <div>
            <h2 className="text-xl font-semibold text-slate-900 mb-4">Profile</h2>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Dashboard Greeting</CardTitle>
                <CardDescription className="text-sm">
                  This controls the name shown in the dashboard header ("Welcome, ...").
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="display-name">Display Name</Label>
                  <Input
                    id="display-name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Enter your preferred display name"
                    maxLength={120}
                  />
                </div>
                <Button onClick={handleSaveDisplayName} disabled={updatePreferences.isPending}>
                  {updatePreferences.isPending ? "Saving..." : "Save Display Name"}
                </Button>
              </CardContent>
            </Card>
          </div>

          <div>
            <h2 className="text-xl font-semibold text-slate-900 mb-4">Supplements</h2>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Supplement Table</CardTitle>
                <CardDescription className="text-sm">
                  Add and manage supplement metadata: brand, link, bottle pricing, quantity, and dose per unit.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-3">
                  <p className="text-sm font-medium text-slate-900">Add Supplement</p>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="space-y-1">
                      <Label>Name</Label>
                      <Input
                        value={newSupplementName}
                        onChange={(e) => setNewSupplementName(e.target.value)}
                        placeholder="Magnesium glycinate"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>Brand</Label>
                      <Input
                        value={newSupplementBrand}
                        onChange={(e) => setNewSupplementBrand(e.target.value)}
                        placeholder="Thorne"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>Timing</Label>
                      <Select
                        value={newSupplementTiming}
                        onValueChange={(value) => setNewSupplementTiming(value as "am" | "pm")}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="am">AM</SelectItem>
                          <SelectItem value="pm">PM</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
                    <div className="space-y-1 md:col-span-2">
                      <Label>Default Daily Amount</Label>
                      <Input
                        value={newSupplementDose}
                        onChange={(e) => setNewSupplementDose(e.target.value)}
                        placeholder="2"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>Unit</Label>
                      <Select
                        value={newSupplementDoseUnit}
                        onValueChange={(value) =>
                          setNewSupplementDoseUnit(value as (typeof SUPPLEMENT_UNITS)[number])
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SUPPLEMENT_UNITS.map((unit) => (
                            <SelectItem key={unit} value={unit}>
                              {unit}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1 md:col-span-2">
                      <Label>Dose Per Unit</Label>
                      <Input
                        value={newSupplementDosePerUnit}
                        onChange={(e) => setNewSupplementDosePerUnit(e.target.value)}
                        placeholder="120 mg per capsule"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="space-y-1">
                      <Label>Product Link</Label>
                      <Input
                        value={newSupplementProductUrl}
                        onChange={(e) => setNewSupplementProductUrl(e.target.value)}
                        placeholder="https://..."
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>Price Per Bottle</Label>
                      <Input
                        value={newSupplementPricePerBottle}
                        onChange={(e) => setNewSupplementPricePerBottle(e.target.value)}
                        placeholder="24.99"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>Quantity Per Bottle</Label>
                      <Input
                        value={newSupplementQuantityPerBottle}
                        onChange={(e) => setNewSupplementQuantityPerBottle(e.target.value)}
                        placeholder="60"
                      />
                    </div>
                  </div>

                  <Button
                    onClick={handleAddSupplementDefinition}
                    disabled={createSupplementDefinition.isPending}
                  >
                    {createSupplementDefinition.isPending ? "Adding..." : "Add Supplement"}
                  </Button>
                </div>

                <div className="space-y-3">
                  {(supplementDefinitions || []).length === 0 ? (
                    <p className="text-sm text-slate-500">No supplements configured yet.</p>
                  ) : (
                    (supplementDefinitions || []).map((definition) => {
                      const draft = supplementDrafts[definition.id];
                      if (!draft) return null;

                      return (
                        <div key={definition.id} className="rounded-lg border border-slate-200 bg-white p-3">
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                            <div className="space-y-1">
                              <Label>Name</Label>
                              <Input
                                value={draft.name}
                                onChange={(e) =>
                                  updateSupplementDraftField(definition.id, "name", e.target.value)
                                }
                              />
                            </div>
                            <div className="space-y-1">
                              <Label>Brand</Label>
                              <Input
                                value={draft.brand}
                                onChange={(e) =>
                                  updateSupplementDraftField(definition.id, "brand", e.target.value)
                                }
                              />
                            </div>
                            <div className="space-y-1">
                              <Label>Timing</Label>
                              <Select
                                value={draft.timing}
                                onValueChange={(value) =>
                                  updateSupplementDraftField(
                                    definition.id,
                                    "timing",
                                    value as "am" | "pm"
                                  )
                                }
                              >
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="am">AM</SelectItem>
                                  <SelectItem value="pm">PM</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                          </div>

                          <div className="mt-3 grid grid-cols-1 md:grid-cols-5 gap-3">
                            <div className="space-y-1 md:col-span-2">
                              <Label>Default Daily Amount</Label>
                              <Input
                                value={draft.dose}
                                onChange={(e) =>
                                  updateSupplementDraftField(definition.id, "dose", e.target.value)
                                }
                              />
                            </div>
                            <div className="space-y-1">
                              <Label>Unit</Label>
                              <Select
                                value={draft.doseUnit}
                                onValueChange={(value) =>
                                  updateSupplementDraftField(
                                    definition.id,
                                    "doseUnit",
                                    value as (typeof SUPPLEMENT_UNITS)[number]
                                  )
                                }
                              >
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {SUPPLEMENT_UNITS.map((unit) => (
                                    <SelectItem key={unit} value={unit}>
                                      {unit}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="space-y-1 md:col-span-2">
                              <Label>Dose Per Unit</Label>
                              <Input
                                value={draft.dosePerUnit}
                                onChange={(e) =>
                                  updateSupplementDraftField(
                                    definition.id,
                                    "dosePerUnit",
                                    e.target.value
                                  )
                                }
                              />
                            </div>
                          </div>

                          <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
                            <div className="space-y-1">
                              <Label>Product Link</Label>
                              <Input
                                value={draft.productUrl}
                                onChange={(e) =>
                                  updateSupplementDraftField(
                                    definition.id,
                                    "productUrl",
                                    e.target.value
                                  )
                                }
                              />
                            </div>
                            <div className="space-y-1">
                              <Label>Price Per Bottle</Label>
                              <Input
                                value={draft.pricePerBottle}
                                onChange={(e) =>
                                  updateSupplementDraftField(
                                    definition.id,
                                    "pricePerBottle",
                                    e.target.value
                                  )
                                }
                              />
                            </div>
                            <div className="space-y-1">
                              <Label>Quantity Per Bottle</Label>
                              <Input
                                value={draft.quantityPerBottle}
                                onChange={(e) =>
                                  updateSupplementDraftField(
                                    definition.id,
                                    "quantityPerBottle",
                                    e.target.value
                                  )
                                }
                              />
                            </div>
                          </div>

                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                updateSupplementDraftField(definition.id, "isLocked", !draft.isLocked)
                              }
                            >
                              {draft.isLocked ? "Locked" : "Unlocked"}
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => handleSaveSupplementDefinition(definition.id)}
                              disabled={updateSupplementDefinition.isPending}
                            >
                              {updateSupplementDefinition.isPending ? "Saving..." : "Save"}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                deleteSupplementDefinition.mutate({ definitionId: definition.id })
                              }
                              disabled={deleteSupplementDefinition.isPending}
                            >
                              <Trash2 className="w-4 h-4 text-red-600" />
                            </Button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Todoist Integration */}
          <div>
            <h2 className="text-xl font-semibold text-slate-900 mb-4">Todoist Integration</h2>
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-slate-100 text-red-600">
                      <CheckSquare className="w-5 h-5" />
                    </div>
                    <div>
                      <CardTitle className="text-base">Todoist</CardTitle>
                      <CardDescription className="text-sm">
                        Connect your Todoist account to manage tasks
                      </CardDescription>
                    </div>
                  </div>
                  {hasTodoistConnected && (
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-2 text-sm text-green-600">
                        <div className="w-2 h-2 bg-green-600 rounded-full"></div>
                        Connected
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          if (todoistIntegration) handleDisconnect(todoistIntegration.id);
                        }}
                      >
                        <Trash2 className="w-4 h-4 text-red-600" />
                      </Button>
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {!hasTodoistConnected && (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="todoist-token">API Token</Label>
                      <Input
                        id="todoist-token"
                        type="password"
                        placeholder="Enter your Todoist API token"
                        value={todoistToken}
                        onChange={(e) => setTodoistToken(e.target.value)}
                      />
                      <p className="text-xs text-slate-500">
                        Get your API token from{" "}
                        <a
                          href="https://todoist.com/help/articles/find-your-api-token-Jpzx9IIlB"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline"
                        >
                          Todoist Settings → Integrations → Developer
                        </a>
                      </p>
                    </div>
                    <Button onClick={handleConnectTodoist} disabled={connectTodoist.isPending}>
                      {connectTodoist.isPending ? "Connecting..." : "Connect Todoist"}
                    </Button>
                  </div>
                )}

                {hasTodoistConnected && (
                  <div className="space-y-3">
                    <Label htmlFor="todoist-default-filter">Default Dashboard Todoist View</Label>
                    <Select value={todoistDefaultFilter} onValueChange={setTodoistDefaultFilter}>
                      <SelectTrigger id="todoist-default-filter">
                        <SelectValue placeholder="Select default view" />
                      </SelectTrigger>
                      <SelectContent>
                        {TODOIST_DEFAULT_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                        {todoistProjects && todoistProjects.length > 0 && (
                          <>
                            <SelectItem value="separator-projects" disabled>
                              ── Projects ──
                            </SelectItem>
                            {todoistProjects.map((project: any) => (
                              <SelectItem key={project.id} value={`project_${project.id}`}>
                                {project.name}
                              </SelectItem>
                            ))}
                          </>
                        )}
                      </SelectContent>
                    </Select>
                    <Button
                      onClick={handleSaveTodoistDefault}
                      disabled={saveTodoistSettings.isPending}
                    >
                      {saveTodoistSettings.isPending
                        ? "Saving..."
                        : "Save Default Todoist View"}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* OpenAI API Key */}
          <div>
            <h2 className="text-xl font-semibold text-slate-900 mb-4">OpenAI Configuration</h2>
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-slate-100 text-green-600">
                      <MessageSquare className="w-5 h-5" />
                    </div>
                    <div>
                      <CardTitle className="text-base">ChatGPT API Key</CardTitle>
                      <CardDescription className="text-sm">
                        Enter your OpenAI API key to enable ChatGPT integration
                      </CardDescription>
                    </div>
                  </div>
                  {connectedProviders.has("openai") && (
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-2 text-sm text-green-600">
                        <div className="w-2 h-2 bg-green-600 rounded-full"></div>
                        Connected
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          const integration = integrations?.find((i) => i.provider === "openai");
                          if (integration) handleDisconnect(integration.id);
                        }}
                      >
                        <Trash2 className="w-4 h-4 text-red-600" />
                      </Button>
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="openai-model">Model</Label>
                  <Select value={openaiModel} onValueChange={setOpenaiModel}>
                    <SelectTrigger id="openai-model">
                      <SelectValue placeholder="Select a model" />
                    </SelectTrigger>
                    <SelectContent>
                      {OPENAI_MODELS.map((model) => (
                        <SelectItem key={model} value={model}>
                          {model}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="openai-key">
                    API Key {connectedProviders.has("openai") ? "(optional to update)" : ""}
                  </Label>
                  <Input
                    id="openai-key"
                    type="password"
                    placeholder={connectedProviders.has("openai") ? "Leave blank to keep current key" : "sk-..."}
                    value={openaiKey}
                    onChange={(e) => setOpenaiKey(e.target.value)}
                  />
                  <p className="text-xs text-slate-500">
                    Get your API key from{" "}
                    <a
                      href="https://platform.openai.com/api-keys"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline"
                    >
                      OpenAI Platform
                    </a>
                  </p>
                </div>
                <Button onClick={handleSaveOpenAI} disabled={connectOpenAI.isPending}>
                  {connectOpenAI.isPending
                    ? "Saving..."
                    : connectedProviders.has("openai")
                      ? "Save OpenAI Settings"
                      : "Connect OpenAI"}
                </Button>
              </CardContent>
            </Card>
          </div>

          {/* OAuth Credentials Configuration */}
          <div>
            <h2 className="text-xl font-semibold text-slate-900 mb-4">OAuth Credentials</h2>
            <p className="text-sm text-slate-600 mb-4">
              Configure your OAuth credentials to enable Google and Microsoft integrations. These credentials are stored securely and only used for authentication.
            </p>
            
            {/* Google Credentials */}
            <Card className="mb-4">
              <CardHeader>
                <CardTitle className="text-base">Google OAuth Credentials</CardTitle>
                <CardDescription className="text-sm">
                  Required for Google Calendar and Gmail integration
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="google-client-id">Client ID</Label>
                  <Input
                    id="google-client-id"
                    type="text"
                    placeholder="Enter Google OAuth Client ID"
                    value={googleClientId}
                    onChange={(e) => setGoogleClientId(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="google-client-secret">Client Secret</Label>
                  <Input
                    id="google-client-secret"
                    type="password"
                    placeholder="Enter Google OAuth Client Secret"
                    value={googleClientSecret}
                    onChange={(e) => setGoogleClientSecret(e.target.value)}
                  />
                </div>
                <p className="text-xs text-slate-500">
                  Get credentials from{" "}
                  <a
                    href="https://console.cloud.google.com/apis/credentials"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline"
                  >
                    Google Cloud Console
                  </a>
                </p>
                <Button onClick={handleSaveGoogleCreds} disabled={saveGoogleCreds.isPending}>
                  {saveGoogleCreds.isPending ? "Saving..." : "Save Google Credentials"}
                </Button>
              </CardContent>
            </Card>

            {/* Microsoft Credentials */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Microsoft OAuth Credentials</CardTitle>
                <CardDescription className="text-sm">
                  Required for OneNote integration
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="microsoft-client-id">Client ID</Label>
                  <Input
                    id="microsoft-client-id"
                    type="text"
                    placeholder="Enter Microsoft Application (client) ID"
                    value={microsoftClientId}
                    onChange={(e) => setMicrosoftClientId(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="microsoft-client-secret">Client Secret</Label>
                  <Input
                    id="microsoft-client-secret"
                    type="password"
                    placeholder="Enter Microsoft Client Secret"
                    value={microsoftClientSecret}
                    onChange={(e) => setMicrosoftClientSecret(e.target.value)}
                  />
                </div>
                <p className="text-xs text-slate-500">
                  Get credentials from{" "}
                  <a
                    href="https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline"
                  >
                    Azure Portal
                  </a>
                </p>
                <Button onClick={handleSaveMicrosoftCreds} disabled={saveMicrosoftCreds.isPending}>
                  {saveMicrosoftCreds.isPending ? "Saving..." : "Save Microsoft Credentials"}
                </Button>
              </CardContent>
            </Card>

            {/* WHOOP Credentials */}
            <Card className="mt-4">
              <CardHeader>
                <CardTitle className="text-base">WHOOP OAuth Credentials</CardTitle>
                <CardDescription className="text-sm">
                  Required for WHOOP recovery/sleep/strain integration
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="whoop-client-id">Client ID</Label>
                  <Input
                    id="whoop-client-id"
                    type="text"
                    placeholder="Enter WHOOP Client ID"
                    value={whoopClientId}
                    onChange={(e) => setWhoopClientId(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="whoop-client-secret">Client Secret</Label>
                  <Input
                    id="whoop-client-secret"
                    type="password"
                    placeholder="Enter WHOOP Client Secret"
                    value={whoopClientSecret}
                    onChange={(e) => setWhoopClientSecret(e.target.value)}
                  />
                </div>
                <p className="text-xs text-slate-500">
                  Create credentials in{" "}
                  <a
                    href="https://developer.whoop.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline"
                  >
                    WHOOP Developer Portal
                  </a>
                  {" "}and add redirect URI: <code>{`${window.location.origin}/api/oauth/whoop/callback`}</code>
                </p>
                <Button onClick={handleSaveWhoopCreds} disabled={saveWhoopCreds.isPending}>
                  {saveWhoopCreds.isPending ? "Saving..." : "Save WHOOP Credentials"}
                </Button>
              </CardContent>
            </Card>
          </div>

          {/* Google Integration */}
          <div>
            <h2 className="text-xl font-semibold text-slate-900 mb-4">Google Services</h2>
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-slate-100 text-blue-600">
                      <Calendar className="w-5 h-5" />
                    </div>
                    <div>
                      <CardTitle className="text-base">Google Calendar & Gmail</CardTitle>
                      <CardDescription className="text-sm">
                        Connect to access your calendar events and emails
                      </CardDescription>
                    </div>
                  </div>
                  {connectedProviders.has("google") && (
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-2 text-sm text-green-600">
                        <div className="w-2 h-2 bg-green-600 rounded-full"></div>
                        Connected
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          const integration = integrations?.find((i) => i.provider === "google");
                          if (integration) handleDisconnect(integration.id);
                        }}
                      >
                        <Trash2 className="w-4 h-4 text-red-600" />
                      </Button>
                    </div>
                  )}
                </div>
              </CardHeader>
              {!connectedProviders.has("google") && (
                <CardContent>
                  <Button onClick={() => window.location.href = "/api/oauth/google"}>
                    Connect with Google
                  </Button>
                  <p className="text-xs text-slate-500 mt-2">
                    You'll be redirected to Google to authorize access to your Calendar and Gmail
                  </p>
                </CardContent>
              )}
            </Card>
          </div>

          {/* Microsoft Integration */}
          <div>
            <h2 className="text-xl font-semibold text-slate-900 mb-4">Microsoft Services</h2>
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-slate-100 text-purple-600">
                      <StickyNote className="w-5 h-5" />
                    </div>
                    <div>
                      <CardTitle className="text-base">OneNote</CardTitle>
                      <CardDescription className="text-sm">
                        Connect to access your OneNote notebooks and pages
                      </CardDescription>
                    </div>
                  </div>
                  {connectedProviders.has("microsoft") && (
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-2 text-sm text-green-600">
                        <div className="w-2 h-2 bg-green-600 rounded-full"></div>
                        Connected
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          const integration = integrations?.find((i) => i.provider === "microsoft");
                          if (integration) handleDisconnect(integration.id);
                        }}
                      >
                        <Trash2 className="w-4 h-4 text-red-600" />
                      </Button>
                    </div>
                  )}
                </div>
              </CardHeader>
              {!connectedProviders.has("microsoft") && (
                <CardContent>
                  <Button onClick={() => window.location.href = "/api/oauth/microsoft"}>
                    Connect with Microsoft
                  </Button>
                  <p className="text-xs text-slate-500 mt-2">
                    You'll be redirected to Microsoft to authorize access to your OneNote
                  </p>
                </CardContent>
              )}
            </Card>
          </div>

          {/* WHOOP Integration */}
          <div>
            <h2 className="text-xl font-semibold text-slate-900 mb-4">Fitness Services</h2>
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-slate-100 text-cyan-600">
                      <Activity className="w-5 h-5" />
                    </div>
                    <div>
                      <CardTitle className="text-base">WHOOP</CardTitle>
                      <CardDescription className="text-sm">
                        Connect to show recovery, sleep, and strain on the dashboard
                      </CardDescription>
                    </div>
                  </div>
                  {connectedProviders.has("whoop") && (
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-2 text-sm text-green-600">
                        <div className="w-2 h-2 bg-green-600 rounded-full"></div>
                        Connected
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          const integration = integrations?.find((i) => i.provider === "whoop");
                          if (integration) handleDisconnect(integration.id);
                        }}
                      >
                        <Trash2 className="w-4 h-4 text-red-600" />
                      </Button>
                    </div>
                  )}
                </div>
              </CardHeader>
              {!connectedProviders.has("whoop") && (
                <CardContent>
                  <Button onClick={() => (window.location.href = "/api/oauth/whoop")}>
                    Connect with WHOOP
                  </Button>
                  <p className="text-xs text-slate-500 mt-2">
                    You&apos;ll be redirected to WHOOP to authorize access
                  </p>
                </CardContent>
              )}
            </Card>
          </div>

          {/* Habit Tracker Configuration */}
          <div>
            <h2 className="text-xl font-semibold text-slate-900 mb-4">Habits</h2>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Habit Tiles</CardTitle>
                <CardDescription className="text-sm">
                  Create habits here. They appear as tappable daily tiles on your dashboard.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="sm:col-span-2 space-y-1">
                    <Label htmlFor="habit-name">Habit Name</Label>
                    <Input
                      id="habit-name"
                      placeholder="Example: No sugar, Workout, Read 20 min"
                      value={newHabitName}
                      onChange={(e) => setNewHabitName(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="habit-color">Color</Label>
                    <Select value={newHabitColor} onValueChange={setNewHabitColor}>
                      <SelectTrigger id="habit-color">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {HABIT_COLOR_OPTIONS.map((color) => (
                          <SelectItem key={color} value={color}>
                            {color}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <Button onClick={handleCreateHabit} disabled={createHabitDefinition.isPending}>
                  <Plus className="w-4 h-4 mr-2" />
                  {createHabitDefinition.isPending ? "Adding..." : "Add Habit"}
                </Button>

                <div className="space-y-2">
                  {habitDefinitions && habitDefinitions.length > 0 ? (
                    habitDefinitions.map((habit) => (
                      <div
                        key={habit.id}
                        className="flex items-center justify-between rounded-md border px-3 py-2 bg-white"
                      >
                        <div>
                          <p className="text-sm font-medium text-slate-900">{habit.name}</p>
                          <p className="text-xs text-slate-500">Color: {habit.color}</p>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => deleteHabitDefinition.mutate({ habitId: habit.id })}
                          disabled={deleteHabitDefinition.isPending}
                        >
                          <Trash2 className="w-4 h-4 text-red-600" />
                        </Button>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-slate-500">No habits yet.</p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
