/**
 * CRUD surface for habits + categories. Uses shadcn Table + inline
 * controls (rename, color, category dropdown, archive).
 */

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { toErrorMessage } from "@/lib/helpers";
import type {
  HabitCategory,
  HabitDefinition,
} from "@/features/dashboard/types";
import { HABIT_COLORS } from "./habits.constants";

export interface HabitsProtocolPanelProps {
  definitions: readonly HabitDefinition[];
  categories: readonly HabitCategory[];
  onChanged: () => void;
}

const UNCATEGORIZED = "__none";

export function HabitsProtocolPanel({
  definitions,
  categories,
  onChanged,
}: HabitsProtocolPanelProps) {
  const [newHabitName, setNewHabitName] = useState("");
  const [newHabitColor, setNewHabitColor] = useState<string>("slate");
  const [newHabitCategory, setNewHabitCategory] = useState<string>(UNCATEGORIZED);

  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryColor, setNewCategoryColor] = useState<string>("slate");

  const createHabit = trpc.habits.createDefinition.useMutation();
  const updateHabit = trpc.habits.updateDefinition.useMutation();
  const deleteHabit = trpc.habits.deleteDefinition.useMutation();
  const createCategory = trpc.habits.createCategory.useMutation();
  const deleteCategory = trpc.habits.deleteCategory.useMutation();

  async function handleCreateHabit() {
    if (!newHabitName.trim()) {
      toast.error("Name is required.");
      return;
    }
    try {
      await createHabit.mutateAsync({
        name: newHabitName.trim(),
        color: newHabitColor,
        categoryId: newHabitCategory === UNCATEGORIZED ? null : newHabitCategory,
      });
      setNewHabitName("");
      onChanged();
    } catch (err) {
      toast.error(toErrorMessage(err));
    }
  }

  async function updateField(
    habitId: string,
    updates: Parameters<typeof updateHabit.mutateAsync>[0]
  ) {
    try {
      await updateHabit.mutateAsync({ ...updates, habitId });
      onChanged();
    } catch (err) {
      toast.error(toErrorMessage(err));
    }
  }

  async function handleDeleteHabit(habitId: string, name: string) {
    if (!window.confirm(`Archive habit "${name}"? Completions remain in history.`))
      return;
    try {
      await deleteHabit.mutateAsync({ habitId });
      onChanged();
    } catch (err) {
      toast.error(toErrorMessage(err));
    }
  }

  async function handleCreateCategory() {
    if (!newCategoryName.trim()) {
      toast.error("Name is required.");
      return;
    }
    try {
      await createCategory.mutateAsync({
        name: newCategoryName.trim(),
        color: newCategoryColor,
      });
      setNewCategoryName("");
      setCategoryDialogOpen(false);
      onChanged();
    } catch (err) {
      toast.error(toErrorMessage(err));
    }
  }

  async function handleDeleteCategory(id: string, name: string) {
    if (!window.confirm(`Delete category "${name}"? Habits will become uncategorized.`))
      return;
    try {
      await deleteCategory.mutateAsync({ id });
      onChanged();
    } catch (err) {
      toast.error(toErrorMessage(err));
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2 pb-2">
          <CardTitle className="text-sm">Add habit</CardTitle>
          <Dialog open={categoryDialogOpen} onOpenChange={setCategoryDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm">
                Manage categories
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Categories</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <div className="grid grid-cols-[1fr_120px_auto] gap-2">
                  <Input
                    placeholder="New category name"
                    value={newCategoryName}
                    onChange={(e) => setNewCategoryName(e.target.value)}
                  />
                  <Select value={newCategoryColor} onValueChange={setNewCategoryColor}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {HABIT_COLORS.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button size="sm" onClick={handleCreateCategory}>
                    Add
                  </Button>
                </div>
                {categories.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No categories yet.
                  </p>
                ) : (
                  <ul className="space-y-1 max-h-60 overflow-y-auto">
                    {categories.map((cat) => (
                      <li
                        key={cat.id}
                        className="flex items-center justify-between rounded-md border px-2 py-1.5 text-sm"
                      >
                        <span>{cat.name}</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-muted-foreground"
                          onClick={() => handleDeleteCategory(cat.id, cat.name)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCategoryDialogOpen(false)}>
                  Close
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent className="grid grid-cols-[1fr_140px_160px_auto] gap-2">
          <Input
            placeholder="Habit name"
            value={newHabitName}
            onChange={(e) => setNewHabitName(e.target.value)}
          />
          <Select value={newHabitColor} onValueChange={setNewHabitColor}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HABIT_COLORS.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={newHabitCategory} onValueChange={setNewHabitCategory}>
            <SelectTrigger>
              <SelectValue placeholder="No category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNCATEGORIZED}>No category</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={handleCreateHabit} disabled={createHabit.isPending}>
            <Plus className="mr-1 h-3 w-3" />
            Add
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Protocol</CardTitle>
        </CardHeader>
        <CardContent>
          {definitions.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No habits yet. Add one above.
            </p>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Color</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {definitions.map((def) => (
                    <TableRow key={def.id}>
                      <TableCell>
                        <Input
                          defaultValue={def.name}
                          onBlur={(e) => {
                            const v = e.target.value.trim();
                            if (v && v !== def.name) {
                              void updateField(def.id, { habitId: def.id, name: v });
                            }
                          }}
                          className="h-8 text-sm"
                        />
                      </TableCell>
                      <TableCell>
                        <Select
                          value={def.color}
                          onValueChange={(v) =>
                            updateField(def.id, { habitId: def.id, color: v })
                          }
                        >
                          <SelectTrigger className="h-8 w-28">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {HABIT_COLORS.map((c) => (
                              <SelectItem key={c} value={c}>
                                {c}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={def.categoryId ?? UNCATEGORIZED}
                          onValueChange={(v) =>
                            updateField(def.id, {
                              habitId: def.id,
                              categoryId: v === UNCATEGORIZED ? null : v,
                            })
                          }
                        >
                          <SelectTrigger className="h-8 w-40">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={UNCATEGORIZED}>
                              (uncategorized)
                            </SelectItem>
                            {categories.map((c) => (
                              <SelectItem key={c.id} value={c.id}>
                                {c.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-muted-foreground"
                          onClick={() => handleDeleteHabit(def.id, def.name)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
