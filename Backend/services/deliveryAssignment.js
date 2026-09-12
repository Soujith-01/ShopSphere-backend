import Order from "../models/Order.js";
import User from "../models/User.js";
import Notification from "../models/Notification.js";

/**
 * Randomly assign an available delivery agent to a shipped order.
 *
 * Called when a seller marks an order "shipped". Picks a random agent who is:
 *   - role "delivery"
 *   - active (not suspended by an admin)
 *   - document-verified by an admin (deliveryPartner.verificationStatus === "approved")
 *   - on duty (deliveryPartner.isAvailable === true)
 *   - not already carrying an out-for-delivery order
 *
 * The order keeps status "shipped" — the assigned agent starts the run via
 * PUT /api/delivery/orders/:orderId/start, which moves it to out_for_delivery.
 * If no agent qualifies, the order stays unassigned and appears in every
 * partner's "Available" list for manual acceptance (graceful fallback).
 *
 * @param {import("mongoose").Document} order - saved Order doc with status "shipped"
 * @returns {Promise<import("mongoose").Document|null>} the order (possibly mutated & saved), or null if the input wasn't a shipped order
 */
export const assignRandomDeliveryAgent = async (order) => {
  if (!order || order.status !== "shipped") return null;

  const busyAgents = await Order.distinct("deliveryPartner", { status: "out_for_delivery" });

  const candidates = await User.aggregate([
    {
      $match: {
        role: "delivery",
        isActive: true,
        "deliveryPartner.verificationStatus": "approved",
        "deliveryPartner.isAvailable": true,
        ...(busyAgents.length > 0 ? { _id: { $nin: busyAgents } } : {}),
      },
    },
    { $sample: { size: 1 } },
  ]);

  const agent = candidates[0];
  if (!agent) return null; // nobody on duty — falls back to manual acceptance

  order.deliveryPartner = agent._id;
  await order.save();

  await Notification.create({
    recipient: agent._id,
    type: "delivery_assigned",
    title: "New Delivery Assigned",
    message: `Order ${order.orderNumber} has been assigned to you. Pick it up from the store and start the delivery when ready.`,
    data: { entityType: "order", entityId: order._id },
  });

  return order;
};
