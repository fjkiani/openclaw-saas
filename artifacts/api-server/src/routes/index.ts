import { Router, type IRouter } from "express";
import healthRouter from "./health";
import tenantsRouter from "./tenants";
import chatRouter from "./chat";
import skillsRouter from "./skills";
import dashboardRouter from "./dashboard";
import billingRouter from "./billing";
import webhooksRouter from "./webhooks";

const router: IRouter = Router();

router.use(healthRouter);
router.use(tenantsRouter);
router.use(chatRouter);
router.use(skillsRouter);
router.use(dashboardRouter);
router.use(billingRouter);
router.use(webhooksRouter);

export default router;
