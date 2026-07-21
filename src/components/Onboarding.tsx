import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, ArrowRight, Box, Cpu, HardDrive, Search, ShieldCheck } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { formatBytes } from "../lib/format";
import type { AppSnapshot } from "../types";
import { BrandMark } from "./ui";

export function Onboarding({
  snapshot,
  onChooseLocal,
  onChooseCatalog,
  onDismiss
}: {
  snapshot: AppSnapshot;
  onChooseLocal: () => void;
  onChooseCatalog: () => void;
  onDismiss: () => void;
}) {
  const [step, setStep] = useState<"welcome" | "model">("welcome");
  const latest = snapshot.metrics.at(-1);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const onDismissRef = useRef(onDismiss);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const background = [...document.querySelectorAll<HTMLElement>(".sidebar, .main-area")];
    background.forEach((element) => element.setAttribute("inert", ""));

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onDismissRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])"
      )];
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      background.forEach((element) => element.removeAttribute("inert"));
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [step]);

  return (
    <motion.div
      ref={dialogRef}
      className="onboarding"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      tabIndex={-1}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <div className="onboarding__aurora" aria-hidden="true"><i /><i /><i /></div>
      <button className="onboarding__skip" onClick={onDismiss}>Continue without a model</button>
      <AnimatePresence mode="wait" initial={false}>
        {step === "welcome" ? (
          <motion.section className="onboarding__step onboarding__welcome" key="welcome" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.3, ease: [0.2, 0.8, 0.2, 1] }}>
            <BrandMark size="hero" />
            <h1 id={titleId}>Your own AI.<br />Entirely on this Mac.</h1>
            <p id={descriptionId}>Requests sent to Hebrus Studio are processed locally. Your selected model and runtime stay under your control.</p>
            <div className="onboarding-hardware">
              <div className="onboarding-hardware__head"><ShieldCheck size={14} /><span>This Mac</span></div>
              <div className="onboarding-hardware__grid">
                <div><span>Chip</span><strong>{snapshot.system.cpuModel.replace(/^Apple\s*/i, "")}</strong></div>
                <div><span>Unified memory</span><strong>{formatBytes(snapshot.system.totalMemoryBytes, 0)}</strong></div>
                <div><span>Free SSD space</span><strong>{latest ? formatBytes(latest.diskFreeBytes, 0) : "Checking…"}</strong></div>
                <div><span>Engine</span><strong>Metal · ds4</strong></div>
              </div>
            </div>
            <button className="onboarding__primary" onClick={() => setStep("model")}>Get started <ArrowRight size={16} /></button>
          </motion.section>
        ) : (
          <motion.section className="onboarding__step onboarding__models" key="model" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.3, ease: [0.2, 0.8, 0.2, 1] }}>
            <button className="onboarding__back" onClick={() => setStep("welcome")}><ArrowLeft size={15} /> Back</button>
            <span className="eyebrow">Choose how to add a model</span>
            <h1 id={titleId}>Start with a model source.</h1>
            <p id={descriptionId}>Nothing downloads and the server never starts until you explicitly ask for it.</p>
            <div className="onboarding-model-grid">
              <button onClick={onChooseLocal}>
                <span className="onboarding-model-grid__icon"><HardDrive size={20} /></span>
                <strong>Use a model on this Mac</strong>
                <p>Scan indexed drives or choose a GGUF file directly in Finder.</p>
                <span className="onboarding-model-grid__facts"><i>No download</i><i>Uses the file in place</i></span>
                <span className="onboarding-model-grid__action"><Search size={14} /> Find local models</span>
              </button>
              <button onClick={onChooseCatalog}>
                <span className="onboarding-model-grid__icon onboarding-model-grid__icon--catalog"><Box size={20} /></span>
                <strong>Browse the Hebrus Studio catalog</strong>
                <p>Review models published on Hugging Face and explicitly confirm any download.</p>
                <span className="onboarding-model-grid__facts"><i>Recommended by Hebrus Studio</i><i>Verified revisions</i></span>
                <span className="onboarding-model-grid__action"><Box size={14} /> Open catalog</span>
              </button>
            </div>
            <div className="onboarding__guarantee"><Cpu size={14} /><span>Model acquisition and server power are separate. Choosing a source will not start Hebrus Studio.</span></div>
          </motion.section>
        )}
      </AnimatePresence>
      <div className="onboarding__dots" aria-label={`Step ${step === "welcome" ? 1 : 2} of 2`}><i className={step === "welcome" ? "active" : ""} /><i className={step === "model" ? "active" : ""} /></div>
    </motion.div>
  );
}
