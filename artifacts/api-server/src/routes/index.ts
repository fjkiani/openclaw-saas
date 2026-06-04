import { Router, type IRouter } from "express";
import healthRouter from "./health";
import tenantsRouter from "./tenants";
import chatRouter from "./chat";
import connectorsRouter from "./connectors";
import graphsRouter from "./graphs";
import skillsRouter from "./skills";
import dashboardRouter from "./dashboard";
import billingRouter from "./billing";
import webhooksRouter from "./webhooks";
import forgeRouter from "./forge";
import legalRouter from "./legal";
import onboardingRouter from "./onboarding";
import manuscriptRouter from "./manuscript";
import seoRouter from "./seo";

const router: IRouter = Router();

router.use(healthRouter);
router.use(tenantsRouter);
router.use(chatRouter);
router.use(connectorsRouter);
router.use(graphsRouter);
router.use(skillsRouter);
router.use(dashboardRouter);
router.use(billingRouter);
router.use(webhooksRouter);
router.use(forgeRouter);
router.use(legalRouter);
router.use(onboardingRouter);
router.use(manuscriptRouter);
router.use(seoRouter);

export default router;
