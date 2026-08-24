import SiteHeader from "@/components/home/SiteHeader";
import Hero from "@/components/home/Hero";
import Reasons from "@/components/home/Reasons";
import RealProject from "@/components/home/RealProject";
import ConceptWorks from "@/components/home/ConceptWorks";
import Services from "@/components/home/Services";
import CtaBand from "@/components/home/CtaBand";
import Pricing from "@/components/home/Pricing";
import Founder from "@/components/home/Founder";
import Process from "@/components/home/Process";
import Faq from "@/components/home/Faq";
import Philosophy from "@/components/home/Philosophy";
import ContactSection from "@/components/home/ContactSection";
import SiteFooter from "@/components/home/SiteFooter";
import Analytics from "@/components/home/Analytics";

export default function Home() {
  return (
    <>
      <Analytics />
      <SiteHeader />
      <main>
        <Hero />
        <Reasons />
        <RealProject />
        <ConceptWorks />
        <Services />
        <CtaBand />
        <Pricing />
        <Founder />
        <Process />
        <Faq />
        <Philosophy />
        <ContactSection />
      </main>
      <SiteFooter />
    </>
  );
}
