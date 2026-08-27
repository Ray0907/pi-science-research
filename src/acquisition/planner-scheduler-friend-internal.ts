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
const CONTROLLER_KEYS=["snapshot","concrete","reservations","transition","close","consume"] as const;

function invalid():never{throw new Error("planner-scheduler friend rejected");}
function controllerDescriptor(value:unknown):ControllerDescriptorInternal{if(value===null||typeof value!=="object"||utilTypes.isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype||!Object.isFrozen(value))invalid();const keys=Reflect.ownKeys(value);if(keys.length>CONTROLLER_KEYS.length||keys.length!==CONTROLLER_KEYS.length||keys.some(key=>typeof key!=="string"||!CONTROLLER_KEYS.includes(key as never)))invalid();const descriptors=Object.getOwnPropertyDescriptors(value);for(const key of CONTROLLER_KEYS)if(!descriptors[key]?.enumerable||!("value" in descriptors[key]!))invalid();return value as ControllerDescriptorInternal;}

/** @internal Planner-only registration seam; AST-confined to planner and this module. */
export function registerAcquisitionPlanExecutionControllerInternal(
  plan:AuthenticatedAcquisitionExecutionPlanInternal,
  descriptor:ControllerDescriptorInternal,
):void{
  if(plan===null||typeof plan!=="object"||utilTypes.isProxy(plan)||!Object.isFrozen(plan)||controllers.has(plan as object))invalid();
  const authenticated=controllerDescriptor(descriptor);
  controllers.set(plan as object,authenticated);
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
