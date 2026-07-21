import type { CatalogModel, CatalogModelVariant } from "../types.js";

export function installableCatalogVariants(model: CatalogModel): CatalogModelVariant[] {
  const declared = Array.isArray(model.variants) ? model.variants : [];
  const variants = declared.length
    ? declared
    : model.installable && model.outputFile && model.totalBytes > 0 && model.files.length
      ? [{
          id: "default",
          label: model.label,
          files: model.files,
          outputFile: model.outputFile,
          totalBytes: model.totalBytes,
          installable: true,
          unavailableReason: null,
          assembly: null
        } satisfies CatalogModelVariant]
      : [];
  return variants
    .filter((variant) => variant.installable && variant.totalBytes > 0 && variant.files.length > 0)
    .sort((left, right) => left.totalBytes - right.totalBytes || left.label.localeCompare(right.label));
}

export function chooseDefaultCatalogVariant(
  model: CatalogModel,
  totalMemoryBytes: number
): CatalogModelVariant | null {
  const variants = installableCatalogVariants(model);
  if (!variants.length) return null;

  const declared = model.outputFile
    ? variants.find((variant) => variant.outputFile === model.outputFile)
    : null;
  if (declared && (model.recommended || variants.length === 1)) return declared;

  const targetBytes = Math.max(1, totalMemoryBytes) * 1.5;
  const withinTarget = variants.filter((variant) => variant.totalBytes <= targetBytes);
  return withinTarget.at(-1) ?? variants[0];
}

export function catalogModelIsReady(model: CatalogModel, totalMemoryBytes: number): boolean {
  const minimumBytes = (model.minimumMemoryGb ?? 0) * 1024 ** 3;
  return model.installable
    && totalMemoryBytes >= minimumBytes
    && Boolean(chooseDefaultCatalogVariant(model, totalMemoryBytes));
}

export function catalogModelForVariant(
  model: CatalogModel,
  variant: CatalogModelVariant
): CatalogModel {
  return {
    ...model,
    files: variant.files,
    outputFile: variant.outputFile,
    totalBytes: variant.totalBytes,
    installable: variant.installable,
    unavailableReason: variant.unavailableReason,
    recommended: model.recommended && model.outputFile === variant.outputFile
  };
}
