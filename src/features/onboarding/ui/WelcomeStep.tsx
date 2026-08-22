import { useEffect, useRef } from "react";
import { motion, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import { updateTelemetryEnabled } from "@/shared/telemetry/consent";
import { OnboardingShell } from "./OnboardingShell";

interface WelcomeStepProps {
  onStart: () => void;
  recordedShareUsageData: boolean | null;
  onRecordShareUsageData: (shareUsageData: boolean) => void;
}

const reveal = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0 },
};

export function WelcomeStep({
  onStart,
  onRecordShareUsageData,
}: WelcomeStepProps) {
  const { t } = useTranslation("onboarding");
  const reduceMotion = useReducedMotion() === true;
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <OnboardingShell contentClassName="max-[760px]:overflow-x-hidden max-[760px]:overflow-y-auto">
      <motion.div
        className="relative flex h-full w-full items-center justify-center px-[clamp(1.5rem,4vw,5rem)] pt-[var(--spacing-app-top-bar)]"
        initial="hidden"
        animate="visible"
        transition={{ staggerChildren: reduceMotion ? 0 : 0.12 }}
      >
        <motion.section
          variants={reveal}
          transition={{ duration: reduceMotion ? 0 : 0.35 }}
          className="w-full max-w-[420px] text-center"
        >
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-[clamp(2.25rem,3.2vw,3.5rem)] leading-[0.98] font-normal tracking-[-0.045em] text-foreground outline-none"
          >
            {t("welcome.title")}
            <br />
            {t("welcome.subtitle")}
          </h1>

          <Button
            type="button"
            size="lg"
            className="mt-9 w-full max-w-[280px]"
            onClick={() => {
              onRecordShareUsageData(false);
              updateTelemetryEnabled(false).catch((error) => {
                console.warn("Failed to persist the usage-data choice:", error);
              });
              onStart();
            }}
          >
            {t("welcome.getStarted")}
          </Button>
        </motion.section>
      </motion.div>
    </OnboardingShell>
  );
}
