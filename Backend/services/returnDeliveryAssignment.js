import User from "../models/User.js";
import Notification from "../models/Notification.js";

/**
 * Randomly assign an available delivery agent to an approved return request.
 *
 * Called when a seller approves a return request. Picks a random agent who is:
 *   - role "delivery"
 *   - active (not suspended by an admin)
 *   - document-verified by an admin (deliveryPartner.verificationStatus === "approved")
 *   - on duty (deliveryPartner.isAvailable === true)
 *
 * If no agent is on duty, returnReq.deliveryPartner stays null and appears in
 * the delivery partner "Available Pickups" list for manual acceptance.
 *
 * @param {import("mongoose").Document} returnReq - approved ReturnRequest doc
 * @param {import("mongoose").Document} order - related Order doc
 * @returns {Promise<Object|null>} the assigned agent user doc, or null if unassigned
 */
export const assignRandomDeliveryAgentForReturn = async (returnReq, order) => {
  if (!returnReq) return null;

  let candidates = await User.aggregate([
    {
      $match: {
        role: "delivery",
        isActive: true,
        "deliveryPartner.verificationStatus": "approved",
        "deliveryPartner.isAvailable": true,
      },
    },
    { $sample: { size: 1 } },
  ]);

  if (!candidates.length) {
    // Fallback: any active on-duty delivery agent
    candidates = await User.aggregate([
      {
        $match: {
          role: "delivery",
          isActive: true,
          "deliveryPartner.isAvailable": true,
        },
      },
      { $sample: { size: 1 } },
    ]);
  }

  const agent = candidates[0];
  if (!agent) return null;

  returnReq.deliveryPartner = agent._id;
  await returnReq.save();

  if (order && !order.deliveryPartner) {
    order.deliveryPartner = agent._id;
    await order.save();
  }

  await Notification.create({
    recipient: agent._id,
    type: "return_assigned",
    title: "New Return Pickup Assigned",
    message: `A return pickup has been assigned to you for Order #${order?.orderNumber || 'Order'}. Please pick up from customer and return to the store.`,
    data: { entityType: "return", entityId: returnReq._id },
  });

  return agent;
};
