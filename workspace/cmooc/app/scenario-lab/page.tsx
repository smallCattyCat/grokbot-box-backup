import type { Metadata } from "next";
import { AutonomySubnav } from "@/components/AutonomySubnav";
import { CourseWorldScenarioLab } from "@/components/scenario-lab/CourseWorldScenarioLab";
import { resolveProductProfile } from "@/lib/product-profile";

const productProfile = resolveProductProfile();

export const metadata: Metadata = {
  title: `研究实验 | ${productProfile.productName}`,
  description: `在不改写课程事实世界的前提下，对冻结证据运行可复核的调度情景实验。`
};

export const dynamic = "force-dynamic";

export default function ScenarioLabPage() {
  return (
    <div className="space-y-3">
      <AutonomySubnav />
      <CourseWorldScenarioLab />
    </div>
  );
}
