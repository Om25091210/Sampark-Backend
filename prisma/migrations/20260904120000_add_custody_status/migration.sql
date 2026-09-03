-- CustodyStatus (this task): a live, reversible custody flag, separate from
-- CadreCategory.jail (register) and PriorityCategory.jail (cadence grade).
-- Null by default on every cadre until explicitly flagged.
CREATE TYPE "CustodyStatus" AS ENUM ('in_custody', 'released');

ALTER TABLE "cadres" ADD COLUMN "custody_status" "CustodyStatus";
