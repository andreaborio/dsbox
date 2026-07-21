import { Download, HardDrive, ShieldCheck, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, InlineNotice, MenuRow, Surface } from "../design-system";
import { assessModelHardware } from "../lib/model-hardware-advisor";
import {
  catalogModelForVariant,
  chooseDefaultCatalogVariant,
  installableCatalogVariants
} from "../lib/model-variants";
import { formatBytes } from "../lib/format";
import { ds4ArtifactFormatLabel } from "../lib/model-format";
import type { CatalogModel } from "../types";
import { Modal } from "./ui";
import "./ModelDownloadDialog.css";

interface Props {
  model: CatalogModel | null;
  totalMemoryBytes: number;
  diskFreeBytes: number;
  busy?: boolean;
  onClose: () => void;
  onConfirm: (variantId: string) => Promise<void> | void;
}

function destination(model: CatalogModel, variantId: string, outputFile: string): string {
  const repository = model.repository.split("/").at(-1) ?? "model";
  const relativeOutput = outputFile.replace(/^\/+/, "") || "model.gguf";
  return `~/.dsbox/models/${repository}/${model.revision}/bundle-${variantId}/${relativeOutput}`;
}

export function ModelDownloadDialog({
  model,
  totalMemoryBytes,
  diskFreeBytes,
  busy = false,
  onClose,
  onConfirm
}: Props) {
  const variants = useMemo(() => model ? installableCatalogVariants(model) : [], [model]);
  const defaultVariant = useMemo(
    () => model ? chooseDefaultCatalogVariant(model, totalMemoryBytes) : null,
    [model, totalMemoryBytes]
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const displayedVariants = useMemo(() => {
    if (!defaultVariant) return variants;
    return [defaultVariant, ...variants.filter((variant) => variant.id !== defaultVariant.id)];
  }, [defaultVariant, variants]);

  useEffect(() => {
    setSelectedId(defaultVariant?.id ?? null);
  }, [defaultVariant?.id, model?.repository]);

  const selected = variants.find((variant) => variant.id === selectedId) ?? defaultVariant;
  const selectedModel = model && selected ? catalogModelForVariant(model, selected) : null;
  const assessment = selectedModel
    ? assessModelHardware(selectedModel, { totalMemoryBytes, diskFreeBytes })
    : null;
  const insufficientDisk = assessment?.storage.status === "insufficient";
  const performanceTone = assessment?.performance.level === "may-be-slow"
    || assessment?.performance.level === "very-slow"
    ? "advisory"
    : "neutral";
  const requiresReview = Boolean(assessment?.requiresAcknowledgement);
  const artifactFormatLabel = ds4ArtifactFormatLabel(model?.artifactFormat);

  return (
    <Modal
      open={Boolean(model)}
      onClose={onClose}
      title={variants.length > 1 ? "Choose a model version" : "Review model download"}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            leadingIcon={<Download size={16} />}
            loading={busy}
            loadingLabel="Starting download"
            disabled={!selected || insufficientDisk}
            onClick={() => selected && void onConfirm(selected.id)}
          >
            {requiresReview ? "Download anyway" : "Download & use"}
          </Button>
        </>
      )}
    >
      {model && selected && assessment ? (
        <div className="model-download-dialog">
          <div className="model-download-dialog__intro">
            <span className="model-download-dialog__icon"><Download size={20} /></span>
            <div>
              <strong>{model.label}</strong>
              <p>Hebrus Studio downloads directly from Hugging Face, verifies every file, and selects the model when it is ready.</p>
            </div>
          </div>

          {artifactFormatLabel && (
            <InlineNotice tone="neutral" title={`${artifactFormatLabel} · Hebrus only`}>
              This file uses a Hebrus-native expert layout. It is not runnable in llama.cpp, MLX, or generic GGUF loaders; keep a canonical GGUF for those runtimes.
            </InlineNotice>
          )}

          {variants.length > 1 && (
            <section className="model-download-dialog__variants" aria-labelledby="model-version-heading">
              <div className="model-download-dialog__section-head">
                <div><strong id="model-version-heading">Version</strong><span>Hebrus Studio selected a balanced default. You can install any complete variant.</span></div>
                <Badge tone="neutral">{variants.length} available</Badge>
              </div>
              <Surface className="model-download-dialog__variant-list" bordered radius="md" padding="none" role="radiogroup" aria-label="Model versions">
                {displayedVariants.map((variant, variantIndex) => {
                  const isDefault = variant.id === defaultVariant?.id;
                  return (
                    <MenuRow
                      key={variant.id}
                      label={variant.label}
                      description={`${formatBytes(variant.totalBytes, 1)} · ${variant.files.length === 1 ? "single GGUF" : `${variant.files.length} shards`}`}
                      trailing={isDefault ? <Badge tone="accent">Best match</Badge> : undefined}
                      selected={variant.id === selected.id}
                      selectionMode="radio"
                      tabIndex={variant.id === selected.id ? 0 : -1}
                      onClick={() => setSelectedId(variant.id)}
                      onKeyDown={(event) => {
                        const lastIndex = displayedVariants.length - 1;
                        const nextIndex = event.key === "ArrowDown" || event.key === "ArrowRight"
                          ? Math.min(lastIndex, variantIndex + 1)
                          : event.key === "ArrowUp" || event.key === "ArrowLeft"
                            ? Math.max(0, variantIndex - 1)
                            : event.key === "Home"
                              ? 0
                              : event.key === "End"
                                ? lastIndex
                                : null;
                        if (nextIndex === null || nextIndex === variantIndex) return;
                        event.preventDefault();
                        setSelectedId(displayedVariants[nextIndex].id);
                        const radios = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>("[role='radio']");
                        window.requestAnimationFrame(() => radios?.[nextIndex]?.focus());
                      }}
                    />
                  );
                })}
              </Surface>
            </section>
          )}

          <InlineNotice
            tone={performanceTone}
            title={assessment.performance.label}
            icon={performanceTone === "advisory" ? <TriangleAlert size={17} /> : <HardDrive size={17} />}
          >
            <p>{assessment.performance.explanation}</p>
            <div className="model-download-dialog__notice-meta">
              <span><ShieldCheck size={12} /> {assessment.compatibility.label}</span>
              <span>{formatBytes(selected.totalBytes, 1)} download</span>
            </div>
          </InlineNotice>

          <dl className="model-download-dialog__facts">
            <div><dt>Download</dt><dd>{formatBytes(selected.totalBytes, 1)}</dd></div>
            <div><dt>Free space</dt><dd>{diskFreeBytes > 0 ? formatBytes(diskFreeBytes, 1) : "Checking…"}</dd></div>
            <div><dt>Files</dt><dd>{selected.files.length === 1 ? "1 GGUF" : `${selected.files.length} GGUF shards`}</dd></div>
            {artifactFormatLabel && <div><dt>Format</dt><dd>{artifactFormatLabel}</dd></div>}
            <div><dt>Revision</dt><dd>{model.revision.slice(0, 12)}</dd></div>
            <div className="model-download-dialog__destination"><dt>Destination</dt><dd title={destination(model, selected.id, selected.outputFile)}>{destination(model, selected.id, selected.outputFile)}</dd></div>
          </dl>

          {insufficientDisk && (
            <InlineNotice tone="danger" title="Not enough free space">
              Free up space or choose a smaller model version before downloading.
            </InlineNotice>
          )}
        </div>
      ) : model ? (
        <InlineNotice tone="danger" title="No complete version available">
          Hugging Face did not expose a complete GGUF bundle that Hebrus Studio can verify and download.
        </InlineNotice>
      ) : null}
    </Modal>
  );
}
