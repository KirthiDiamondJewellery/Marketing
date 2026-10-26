// Which screen each robot shows.

import type { ComponentType } from "react";
import type { RobotId } from "../cast";
import type { SceneProps } from "./bits";
import { Captions, Cutter, Remix } from "./editing";
import { CommentReplies, DmCloser, LeadLogger } from "./inbox";
import { FilmList, IdeaPicker, LaneBalance } from "./planning";
import { CrossPoster, Scheduler, Thumbnails } from "./publishing";
import { CompetitorWatch, TranscriptReader, TrendScout } from "./research";
import { HookWriter, ScriptWriter, VoiceCheck } from "./scripting";

export const SCENES: Record<RobotId, ComponentType<SceneProps>> = {
  trend: TrendScout,
  rival: CompetitorWatch,
  transcript: TranscriptReader,
  ideas: IdeaPicker,
  lanes: LaneBalance,
  slate: FilmList,
  hook: HookWriter,
  script: ScriptWriter,
  voice: VoiceCheck,
  cutter: Cutter,
  captions: Captions,
  remix: Remix,
  thumbs: Thumbnails,
  scheduler: Scheduler,
  poster: CrossPoster,
  comments: CommentReplies,
  dm: DmCloser,
  leads: LeadLogger,
};
