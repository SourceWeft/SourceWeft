"use client";

import { Plus, X } from "lucide-react";
import {
  TABLE_COLUMN_TYPES,
  TABLE_LIMITS,
  type TableColumnInput,
  type TableColumnType,
} from "@sourceweft/contracts/table";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import { blankTableColumn } from "./column-inputs";
import type { TableTranslate } from "./table-host";

export type ColumnEditorProps = {
  value: readonly TableColumnInput[];
  onChange: (columns: TableColumnInput[]) => void;
  /** At most this many columns; defaults to the table limit. */
  max?: number;
  /** Translations for the `table.editor.*` keys. */
  t: TableTranslate;
  disabled?: boolean;
};

const SELECT_CLASS =
  "h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * The columns of a table as a person states them: a name, an optional
 * description of what to look for, and the kind of value. A column that
 * already exists keeps its id however it is edited, so a regeneration can
 * reuse its cells when nothing that matters changed.
 */
export function ColumnEditor({
  value,
  onChange,
  max = TABLE_LIMITS.maxColumns,
  t,
  disabled = false,
}: ColumnEditorProps) {
  const update = (index: number, patch: Partial<TableColumnInput>) =>
    onChange(value.map((column, i) => (i === index ? { ...column, ...patch } : column)));
  const remove = (index: number) => onChange(value.filter((_, i) => i !== index));
  const atMax = value.length >= max;

  return (
    <fieldset className="grid min-w-0 gap-2" disabled={disabled}>
      <legend className="sr-only">{t("table.editor.label")}</legend>
      {value.map((column, index) => {
        const position = index + 1;
        const nameMissing = column.name.trim() === "";
        return (
          <div
            className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-start gap-2 rounded-lg border bg-muted/20 p-2"
            // Rows have no identity until generated; the list is edited in place.
            key={index}
          >
            <div className="grid min-w-0 gap-1.5">
              <Input
                aria-invalid={nameMissing || undefined}
                aria-label={t("table.editor.name", { position })}
                maxLength={TABLE_LIMITS.columnNameChars}
                name="table-column-name"
                onChange={(event) => update(index, { name: event.target.value })}
                placeholder={t("table.editor.namePlaceholder")}
                value={column.name}
              />
              <Input
                aria-label={t("table.editor.description", { position })}
                className="text-xs"
                maxLength={TABLE_LIMITS.columnDescriptionChars}
                name="table-column-description"
                onChange={(event) => update(index, { description: event.target.value })}
                placeholder={t("table.editor.descriptionPlaceholder")}
                value={column.description ?? ""}
              />
            </div>
            <select
              aria-label={t("table.editor.type", { position })}
              className={SELECT_CLASS}
              name="table-column-type"
              onChange={(event) =>
                update(index, { type: event.target.value as TableColumnType })
              }
              value={column.type}
            >
              {TABLE_COLUMN_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`table.editor.types.${type}`)}
                </option>
              ))}
            </select>
            <Button
              aria-label={t("table.editor.remove", { position })}
              onClick={() => remove(index)}
              size="icon"
              type="button"
              variant="ghost"
            >
              <X aria-hidden />
            </Button>
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={atMax}
          onClick={() => onChange([...value, blankTableColumn()])}
          size="sm"
          type="button"
          variant="outline"
        >
          <Plus aria-hidden />
          {t("table.editor.add")}
        </Button>
        {atMax ? (
          <p className="text-xs text-muted-foreground">{t("table.editor.max", { max })}</p>
        ) : null}
      </div>
    </fieldset>
  );
}
