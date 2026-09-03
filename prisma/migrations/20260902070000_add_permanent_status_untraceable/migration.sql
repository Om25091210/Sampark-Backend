-- This task. Fourth permanent mark becomes a fifth: अप्राप्य (untraceable) joins
-- फौत/शासकीय नौकरी/GS/अन्य जिले में निवासरत as a PermanentStatus value carrying the
-- same "no further reporting required" exemption (see recency.ts) -- no other
-- schema change needed, the column already accepts any PermanentStatus value.
ALTER TYPE "PermanentStatus" ADD VALUE 'untraceable';
