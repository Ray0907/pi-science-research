import {types as utilTypes} from "node:util";

import type {
  AcquisitionExecutionPlanSnapshotInternal,
  AuthenticatedAcquisitionExecutionPlanInternal,
  ConditionalMaterializationFactsInternal,
  ConditionalMaterializationResultInternal,
  ConditionalPartitionReservationInternal,
  InvocationPlannedPartitionInternal,
} from "./planner-internal.js";

export interface AcquisitionPlanExecutionControllerInternal {
  readonly snapshot:AcquisitionExecutionPlanSnapshotInternal;
  readonly concrete:readonly InvocationPlannedPartitionInternal[];
  readonly reservations:readonly ConditionalPartitionReservationInternal[];
  transition(
    reservation:ConditionalPartitionReservationInternal,
    facts:ConditionalMaterializationFactsInternal|null,
    reason:"parent-failed"|"parent-blocked"|null,
  ):ConditionalMaterializationResultInternal;
  close():void;
}

interface ControllerDescriptorInternal extends AcquisitionPlanExecutionControllerInternal {
  consume():void;
}

const controllers=new WeakMap<object,ControllerDescriptorInternal>();

function invalid():never{throw new Error("planner-scheduler friend rejected");}

/** @internal Planner-only registration seam; AST-confined to planner and this module. */
export function registerAcquisitionPlanExecutionControllerInternal(
  plan:AuthenticatedAcquisitionExecutionPlanInternal,
  descriptor:ControllerDescriptorInternal,
):void{
  if(plan===null||typeof plan!=="object"||utilTypes.isProxy(plan)||!Object.isFrozen(plan)||controllers.has(plan as object))invalid();
  if(descriptor===null||typeof descriptor!=="object"||utilTypes.isProxy(descriptor)||!Object.isFrozen(descriptor))invalid();
  controllers.set(plan as object,descriptor);
}

/** @internal Scheduler-only atomic one-consumer seam. */
export function consumeAcquisitionPlanExecutionControllerInternal(
  plan:AuthenticatedAcquisitionExecutionPlanInternal,
):AcquisitionPlanExecutionControllerInternal{
  if(plan===null||typeof plan!=="object"||utilTypes.isProxy(plan)||!Object.isFrozen(plan))invalid();
  const descriptor=controllers.get(plan as object);if(!descriptor)invalid();
  descriptor.consume();
  return descriptor;
}
