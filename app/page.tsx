import { FeaturePreview } from "@/components/landing/FeaturePreview";
import { HeroSection } from "@/components/landing/HeroSection";
import { RoadmapTeaser } from "@/components/landing/RoadmapTeaser";
import { SiteFooter } from "@/components/landing/SiteFooter";
import { SiteHeader } from "@/components/landing/SiteHeader";

export default function Home() {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <SiteHeader />
      <main className="flex-1">
        <HeroSection />
        <FeaturePreview />
        <RoadmapTeaser />
      </main>
      <SiteFooter />
    </div>
  );
}
