import { FIRST_VIEW_MENU_ITEMS } from "@/lib/design-agent/layout";
import type { Layout } from "@/lib/design-agent/profile";
import type { DemoView } from "@/lib/sales/demo-content";
import { FactText, ROW_EN } from "../parts";
import sx from "../sections.module.css";
import { HEADING_WORDS } from "./common";

// What the first view shows besides the name (DEV-071a), inside the hero's
// title block, from the facts of a normalized layout only:
//   name_lead   the description (the about section is then not drawn)
//   name_hours  the opening hours (also in the hours or visit section)
//   name_menu   the first menu items in the shop's order (all of them stay in the menu section)
// name_only and vertical_name add nothing here.

export default function FirstView({ view, demo }: { view: Layout["firstView"]; demo: DemoView }) {
  if (view === "name_lead" && demo.description) {
    return (
      <p className={sx.fvLead} data-fv="lead">
        {demo.description}
      </p>
    );
  }
  if (view === "name_hours" && demo.hours) {
    return (
      <p className={sx.fvHours} data-fv="hours">
        <span className={sx.fvLabel}>
          <span lang="en">{ROW_EN.hours}</span>
          <span>{HEADING_WORDS.hours.ja}</span>
        </span>
        <span className={sx.fvValue}>
          <FactText text={demo.hours} />
        </span>
      </p>
    );
  }
  if (view === "name_menu" && demo.menuItems.length > 0) {
    return (
      <div className={sx.fvMenu} data-fv="menu">
        <p className={sx.fvLabel}>
          <span lang="en">{HEADING_WORDS.menu.en}</span>
          <span>{HEADING_WORDS.menu.ja}</span>
        </p>
        <ul className={sx.fvItems}>
          {demo.menuItems.slice(0, FIRST_VIEW_MENU_ITEMS).map((item, i) => (
            <li key={`${i}-${item}`}>{item}</li>
          ))}
        </ul>
      </div>
    );
  }
  return null;
}
